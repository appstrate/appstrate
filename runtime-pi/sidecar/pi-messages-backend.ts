// SPDX-License-Identifier: Apache-2.0

/**
 * `pi-messages` backend for an ALIASED run.
 *
 * pi-ai re-derives every vendor quirk per request from `model.provider` +
 * `model.baseUrl`, so a container handed the real provider id emits that
 * vendor's request shape and reads its response vocabulary back. The org member
 * controls the agent code, so the observable is the RAW BYTES: renaming
 * identifying fields would be a blacklist over a set nobody can enumerate — a
 * property of 14 live vendor APIs, not of our source.
 *
 * So the container speaks pi-ai's vendor-neutral `pi-messages` and this module
 * is its backend: `POST <baseUrl>/messages` with `{ model, context, options }`
 * — the model ID only, never the Model record — answered by an SSE stream of
 * `PiMessagesEvent`, a CLOSED union nothing vendor-shaped can ride in. No quirk
 * table is mirrored: {@link handlePiMessagesRequest} rebuilds the REAL backing's
 * `Model` for pi-ai's own `streamSimple`, so every per-vendor serializer keeps
 * running one process to the left of the container.
 *
 * The projection onto that union is a WHITELIST: every outbound event is built
 * field by field and NO inbound object is ever spread into an outbound one. A
 * spread would ship the next pi-ai version's new fields to the container
 * silently, and `partial` carries `api`, `provider` and the real model id.
 */

import type { LlmProxyApiKeyConfig, ModelSwap, SidecarConfig } from "./helpers.ts";
import { LLM_PROXY_TIMEOUT_MS } from "./helpers.ts";
import { anthropicThinkingBudgets } from "@appstrate/core/model-generation";
import { PI_SDK_VERSION, PI_SDK_VERSION_HEADER } from "@appstrate/runner-pi/provider-map";
import { PLATFORM_MODEL_COMPAT } from "@appstrate/runner-pi/model-compat";
import { logger } from "./logger.ts";
import { syntheticAliasErrorBody, syntheticAliasErrorMessage } from "./model-swap.ts";
import { streamBacking } from "./pi-sdk.ts";
import type {
  Api,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  PiMessagesEvent,
  SimpleStreamOptions,
  ThinkingLevel,
  ToolCall,
  Usage,
} from "./pi-sdk.ts";

/** Reported once per process: a per-request warn would bury the signal. */
let sdkDriftWarned = false;

/** Test seam: clears the once-per-process latch so cases stay order-independent. */
export function _resetSdkDriftWarningForTesting(): void {
  sdkDriftWarned = false;
}

/**
 * Name a container/sidecar pi-ai mismatch once. `PI_IMAGE`/`SIDECAR_IMAGE` are
 * a version contract, not two knobs — the env schema fails platform boot when
 * their tags disagree — so what is left for this to catch is the drift a tag
 * cannot express: the SAME tag built twice (`:latest` rebuilt on one side only,
 * which `services/orchestrator/runtime-image-pair.ts` only warns about), or a
 * digest-pinned pair, which the tag rule exempts. `PiMessagesEvent` is
 * pi-ai-internal, so that drift matters here. Warns rather than rejects — a
 * mismatch usually still works, and an absent header means a container built
 * before the header existed. The header is container-controlled, so the latch is
 * a SINGLE flag and the value is TRUNCATED: keying a cache on it would let the
 * container grow the sidecar's memory one distinct value at a time.
 */
function warnOnSdkDrift(request: Request): void {
  const container = request.headers.get(PI_SDK_VERSION_HEADER);
  if (!container || container === PI_SDK_VERSION) return;
  if (sdkDriftWarned) return;
  sdkDriftWarned = true;
  logger.warn(
    "pi-messages backend: container and sidecar were built against different pi-ai versions",
    { container: container.slice(0, 32), sidecar: PI_SDK_VERSION },
  );
}

/**
 * Default response cap when the platform resolved none. pi-ai falls back to
 * `model.maxTokens` when the caller sends no cap, so it has to be real; 16384
 * is pi's own default for a definition that declares none.
 */
const PI_DEFAULT_MAX_TOKENS = 16_384;

/** Zero per-token rates for the rebuilt `Model` — see {@link buildBackingModel}. */
const ZERO_RATES = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/** The same zeros in `Usage.cost` shape (which adds the `total` roll-up). */
const ZERO_USAGE_COST = { ...ZERO_RATES, total: 0 } as const;

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { ...ZERO_USAGE_COST },
};

interface PiMessagesRequestBody {
  model: string;
  context: Context;
  options?: {
    temperature?: number;
    maxTokens?: number;
    reasoning?: ThinkingLevel;
    sessionId?: string;
  };
}

/**
 * The pi-ai entry point this module drives. Injected so a test can wrap it with
 * pi-ai's `onPayload` probe and assert on the bytes actually originated (the
 * repo bans `mock.module()`); production passes {@link streamBacking}.
 */
export type BackingStreamFn = (
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface PiMessagesBackendDeps {
  /** The run's LLM config — supplies the real base URL, key and swap descriptor. */
  llm: LlmProxyApiKeyConfig;
  /** The alias descriptor. Its `backing` is what this module rebuilds the Model from. */
  swap: ModelSwap;
  /**
   * The backing's real token limits. Not a sidecar-only secret: the container
   * gets the identical pair, because it needs them to size compaction and the
   * `usage.input` count a run reports out-tells them anyway (`container-env.ts`,
   * `MODEL_ALIASES.md`). They are here so the rebuilt `Model` clamps the same way.
   */
  limits: Pick<SidecarConfig, "modelContextWindow" | "modelMaxTokens">;
  /** Defaults to {@link streamBacking}. */
  streamBackingFn?: BackingStreamFn;
}

/**
 * Rebuild the pi-ai `Model` record of the REAL backing. `cost` is deliberately
 * ZERO, not the backing's rate card: pi-ai writes `usage.cost` from it every
 * settled turn and that number would ride the terminal `done` event to the
 * container, where a published card is one catalog lookup from a vendor name.
 * The platform prices the ledger row itself; the SDK requires the shape, so
 * zero is what it gets.
 */
export function buildBackingModel(deps: PiMessagesBackendDeps): Model<Api> {
  const { swap, llm, limits } = deps;
  const backing = swap.backing;
  if (!backing) {
    // `parseModelSwapEnv` refuses this at boot; restated so the function
    // carries no implicit precondition.
    throw new Error("pi-messages backend: modelSwap.backing is required to re-originate");
  }
  return {
    id: swap.real,
    // Never surfaced: the projection drops `partial`, where pi-ai puts these.
    name: swap.real,
    api: swap.backingApiShape,
    // Load-bearing: with `baseUrl` this is what pi-ai reads to pick the
    // vendor's request shape — the derivation the container no longer performs.
    provider: backing.providerId,
    baseUrl: llm.baseUrl,
    reasoning: backing.reasoning,
    ...(backing.reasoningLevelMap ? { thinkingLevelMap: backing.reasoningLevelMap } : {}),
    compat: {
      // The STRUCTURAL half of the cache-retention refusal — see
      // {@link FORWARDED_OPTION_KEYS} for the request-body half, and
      // `PLATFORM_MODEL_COMPAT` for the billing reason both close.
      ...PLATFORM_MODEL_COMPAT,
      // pi-ai gates its adaptive branch on `compat.forceAdaptiveThinking`, which
      // it sources from metadata it has none of for a record rebuilt from the
      // platform's catalog. Without the flag an adaptive backing gets the classic
      // `thinking: {type:"enabled", budget_tokens}` shape and answers 400.
      ...(swap.anthropicAdaptiveReasoning ? { forceAdaptiveThinking: true } : {}),
    },
    input: narrowInputModalities(backing.input),
    cost: { ...ZERO_RATES },
    // The REAL limits: `maxTokens` is the upstream response cap, `contextWindow`
    // sizes pi-ai's clamp, and a zero window is pi-ai's "do not clamp" sentinel.
    contextWindow: limits.modelContextWindow ?? 0,
    maxTokens: limits.modelMaxTokens ?? PI_DEFAULT_MAX_TOKENS,
  };
}

/**
 * Narrow the platform's free-string modalities onto pi's closed pair, with the
 * `["text"]` floor `runtime-pi/env.ts` applies: an empty list disables text too.
 */
function narrowInputModalities(input: ReadonlyArray<string>): ("text" | "image")[] {
  const known = input.filter((m): m is "text" | "image" => m === "text" || m === "image");
  return known.length > 0 ? known : ["text"];
}

/**
 * The `options` members this boundary forwards upstream — the whitelist half of
 * {@link projectRequestOptions}. All portable `pi-messages` vocabulary, so
 * forwarding them grants the container nothing it could not already ask for.
 *
 * `cacheRetention` is portable vocabulary too and is deliberately NOT here. The
 * body is the CONTAINER's, so the agent picks its value, and Anthropic long
 * retention bills cache-creation tokens at 2× the input rate — a bucket the
 * platform's authoritative `computeTokenCost` has no term for. Forwarding it
 * would let an aliased run make its own ledger row cheaper than the call it
 * made. `apps/api/test/unit/runner-cost-parity.test.ts` pins that as the
 * precondition for dropping pi-ai's `cacheWrite1h` branch.
 */
export const FORWARDED_OPTION_KEYS: ReadonlySet<string> = new Set([
  "temperature",
  "maxTokens",
  "reasoning",
  "sessionId",
]);

/**
 * Log every field that reached this boundary and will NOT reach the backing:
 * `toolChoice`, whose value space differs per vendor so honouring it would mean
 * the per-vendor mapping table this design avoids; `cacheRetention`, which the
 * platform cannot price (see {@link FORWARDED_OPTION_KEYS}); and `debug`, which
 * asks a backend for routing metadata about itself. Reported as a SET DIFFERENCE
 * against {@link FORWARDED_OPTION_KEYS}, never a blacklist of those three names,
 * so an option a future pi-ai adds is visible the day it appears instead of
 * vanishing with the constraint the agent asked for. WARNS, never rejects —
 * failing would break every aliased run on a pi upgrade. Names FIELDS only:
 * sidecar logs are operator-visible.
 */
function warnOnDiscardedRequestFields(body: PiMessagesRequestBody, requestUrl: string): void {
  const discarded = Object.keys(body.options ?? {})
    .filter((key) => !FORWARDED_OPTION_KEYS.has(key))
    .map((key) => `options.${key}`);
  try {
    if (new URL(requestUrl).searchParams.has("debug")) discarded.push("query.debug");
  } catch {
    // The router already matched on this URL; report what the body alone showed.
  }
  if (discarded.length === 0) return;
  logger.warn(
    "pi-messages backend: request fields not forwarded to the backing " +
      "(vendor-specific or backend-introspective — see warnOnDiscardedRequestFields)",
    { discarded },
  );
}

/**
 * Vendor-neutral options forwarded from the client's payload. The set is
 * {@link FORWARDED_OPTION_KEYS}; anything else is logged by
 * {@link warnOnDiscardedRequestFields} rather than dropped silently.
 */
function projectRequestOptions(
  body: PiMessagesRequestBody,
  swap: ModelSwap,
  apiKey: string,
  signal: AbortSignal,
): SimpleStreamOptions {
  const incoming = body.options ?? {};
  return {
    apiKey,
    signal,
    ...(incoming.temperature !== undefined ? { temperature: incoming.temperature } : {}),
    ...(incoming.maxTokens !== undefined ? { maxTokens: incoming.maxTokens } : {}),
    ...(incoming.reasoning !== undefined ? { reasoning: incoming.reasoning } : {}),
    ...(incoming.sessionId !== undefined ? { sessionId: incoming.sessionId } : {}),
    // A classic (non-adaptive) Anthropic call needs a request-scoped thinking
    // budget that `PiMessagesOptions` models no field for, so the container
    // cannot send one. Same core rule `pi-runner` applies on the direct path;
    // without it the run drops to pi's table, which collapses `xhigh` and `max`.
    ...(swap.backingApiShape === "anthropic-messages" && incoming.reasoning !== undefined
      ? { thinkingBudgets: anthropicThinkingBudgets(incoming.reasoning) }
      : {}),
  };
}

/**
 * Token counts for the terminal event, rebuilt field by field. Keeps exactly
 * the four buckets the platform prices the ledger row from, so dropping any
 * would lose the bill. The two OPTIONAL `Usage` members go instead:
 * `cacheWrite1h` is reported only by Anthropic and `reasoning` only by
 * providers exposing a breakdown, so their mere PRESENCE narrows the candidate
 * vendor, and neither is priced. `cost` is zeroed for the same reason
 * `Model.cost` is; see {@link buildBackingModel}.
 */
function projectUsage(usage: Usage): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: { ...ZERO_USAGE_COST },
  };
}

/** Rebuild one tool call, field by field — `ToolCall` is a closed shape. */
function projectToolCall(call: ToolCall): ToolCall {
  return {
    type: "toolCall",
    id: call.id,
    name: call.name,
    arguments: call.arguments,
    ...(call.thoughtSignature !== undefined ? { thoughtSignature: call.thoughtSignature } : {}),
    ...(call.namespace !== undefined ? { namespace: call.namespace } : {}),
  };
}

/**
 * Project one pi-ai `AssistantMessageEvent` onto the `pi-messages` wire event.
 *
 * Three variants read back from `partial.content[contentIndex]` because the
 * inbound event lacks a field the outbound one declares (`toolcall_start` has
 * no `id` / `toolName`; `text_end` / `thinking_end` carry no signature). That
 * read is itself a whitelist — named fields off a known content block, never
 * the block itself. Returns `undefined` for an event with no wire counterpart,
 * today only `done` with `reason: "deferred"`: the client cannot request those
 * and this backend never enables them, so the caller synthesizes the terminal.
 */
export function projectAssistantEvent(event: AssistantMessageEvent): PiMessagesEvent | undefined {
  switch (event.type) {
    case "start":
      return { type: "start" };
    case "text_start":
      return { type: "text_start", contentIndex: event.contentIndex };
    case "text_delta":
      return { type: "text_delta", contentIndex: event.contentIndex, delta: event.delta };
    case "text_end": {
      const block = event.partial.content[event.contentIndex];
      const signature = block?.type === "text" ? block.textSignature : undefined;
      return {
        type: "text_end",
        contentIndex: event.contentIndex,
        content: event.content,
        ...(signature !== undefined ? { contentSignature: signature } : {}),
      };
    }
    case "thinking_start":
      return { type: "thinking_start", contentIndex: event.contentIndex };
    case "thinking_delta":
      return { type: "thinking_delta", contentIndex: event.contentIndex, delta: event.delta };
    case "thinking_end": {
      const block = event.partial.content[event.contentIndex];
      const thinking = block?.type === "thinking" ? block : undefined;
      return {
        type: "thinking_end",
        contentIndex: event.contentIndex,
        content: event.content,
        ...(thinking?.thinkingSignature !== undefined
          ? { contentSignature: thinking.thinkingSignature }
          : {}),
        ...(thinking?.redacted !== undefined ? { redacted: thinking.redacted } : {}),
      };
    }
    case "toolcall_start": {
      const block = event.partial.content[event.contentIndex];
      const call = block?.type === "toolCall" ? block : undefined;
      return {
        type: "toolcall_start",
        contentIndex: event.contentIndex,
        id: call?.id ?? "",
        toolName: call?.name ?? "",
      };
    }
    case "toolcall_delta":
      return { type: "toolcall_delta", contentIndex: event.contentIndex, delta: event.delta };
    case "toolcall_end":
      return {
        type: "toolcall_end",
        contentIndex: event.contentIndex,
        toolCall: projectToolCall(event.toolCall),
      };
    case "done":
      if (event.reason === "deferred") return undefined;
      return { type: "done", reason: event.reason, usage: projectUsage(event.message.usage) };
    case "error":
      // `event.error.errorMessage` interpolates `model.provider` on several
      // pi-ai paths and carries the vendor's own prose on the rest. Errors are
      // SYNTHESIZED, never scrubbed: the caller supplies the neutral text, so
      // this case returns reason and usage only.
      return { type: "error", reason: event.reason, usage: projectUsage(event.error.usage) };
  }
}

/** One SSE frame. `data:` only — `pi-messages` reads no event name or id. */
function sseFrame(event: PiMessagesEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Parse the client body, or explain why it is unusable. */
function parseRequestBody(bodyText: string): PiMessagesRequestBody | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return "not valid JSON";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "expected a JSON object";
  }
  const candidate = parsed as Partial<PiMessagesRequestBody>;
  if (!candidate.context || typeof candidate.context !== "object") return 'missing "context"';
  if (!Array.isArray(candidate.context.messages)) return 'missing "context.messages"';
  return candidate as PiMessagesRequestBody;
}

/**
 * Serve one `POST /llm/messages` on an aliased run: terminate `pi-messages`,
 * re-originate through pi-ai against the real backing, stream the projected
 * events back. Once the body parses the response is always 200 + SSE — pi-ai's
 * `pi-messages` reader treats a non-2xx as a transport failure and never
 * reaches the terminal event, so an upstream refusal has to arrive as an
 * `error` EVENT to read as a failed turn; a body that does not parse never got
 * as far as a stream and answers with the neutral HTTP envelope. The client's
 * `model` is ignored, not swapped: the upstream request is built from the
 * descriptor's real id, so nothing the container sends redirects the call.
 */
export function handlePiMessagesRequest(
  deps: PiMessagesBackendDeps,
  request: Request,
  bodyText: string,
): Response {
  const { swap } = deps;

  const body = parseRequestBody(bodyText);
  if (typeof body === "string") {
    // The reason names the CLIENT's malformed body, never the backing, so it is
    // safe to log verbatim; the caller-facing envelope stays neutral.
    logger.warn("pi-messages backend: unusable request body", { reason: body });
    return new Response(syntheticAliasErrorBody(swap, 400), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  warnOnDiscardedRequestFields(body, request.url);
  warnOnSdkDrift(request);

  const model = buildBackingModel(deps);
  const stream = deps.streamBackingFn ?? streamBacking;

  // The same absolute deadline the non-aliased `/llm/*` forward applies, plus
  // the client's disconnect — whichever fires first unwinds pi-ai's fetch.
  const signal = AbortSignal.any([AbortSignal.timeout(LLM_PROXY_TIMEOUT_MS), request.signal]);
  const upstream = stream(
    model,
    body.context,
    projectRequestOptions(body, swap, deps.llm.apiKey, signal),
  );

  const encoder = new TextEncoder();
  const sse = new ReadableStream<Uint8Array>({
    async start(controller) {
      let terminal: PiMessagesEvent | undefined;
      try {
        for await (const event of upstream) {
          const projected = projectAssistantEvent(event);
          if (!projected) continue;
          if (projected.type === "error") {
            // Attached here so the projection never reads the alias descriptor.
            terminal = { ...projected, errorMessage: syntheticAliasErrorMessage(swap) };
            break;
          }
          if (projected.type === "done") {
            terminal = projected;
            break;
          }
          controller.enqueue(encoder.encode(sseFrame(projected)));
        }
      } catch (err) {
        // pi-ai surfaces failures as an `error` EVENT, so reaching here means
        // the stream machinery broke. Server-side log, so it may name the
        // backing; the client still gets the synthesized terminal below.
        logger.warn("pi-messages backend: upstream stream threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!terminal) {
        // The client MUST see a terminal: `pi-messages` reconstructs the
        // assistant message from it, and its absence hangs the turn.
        terminal = {
          type: "error",
          reason: "error",
          usage: EMPTY_USAGE,
          errorMessage: syntheticAliasErrorMessage(swap),
        };
      }
      controller.enqueue(encoder.encode(sseFrame(terminal)));
      controller.close();
    },
  });

  return new Response(sse, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
