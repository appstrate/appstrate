// SPDX-License-Identifier: Apache-2.0

/**
 * `pi-messages` backend for an ALIASED run (issue #1198, Threat B).
 *
 * ## What this closes
 *
 * pi-ai re-derives every vendor quirk per request from `model.provider` +
 * `model.baseUrl` (`getCompat` / `detectCompat` in
 * `pi-ai/dist/api/openai-completions.js`). Handing the agent container the REAL
 * provider id — which is what makes a DeepSeek run emit DeepSeek's request
 * shape instead of plain OpenAI's — also makes the container emit, and read
 * back, that vendor's own vocabulary: `reasoning_content` vs `reasoning`,
 * `prompt_cache_hit_tokens` vs `prompt_tokens_details.cached_tokens`, and
 * fields pi-ai never even reads (`system_fingerprint` appears nowhere in it)
 * that still cross the wire untouched. An org member controls the agent code,
 * so the observable is the RAW BYTES: renaming identifying fields would be a
 * blacklist over a set nobody can enumerate, because that set is a property of
 * 14 live vendor APIs rather than of our source.
 *
 * So the container speaks pi-ai's OWN vendor-neutral protocol instead, and this
 * module is its backend. `pi-messages` is a first-class `KnownApi` its own
 * source documents as usable by any backend: the request is
 * `POST <baseUrl>/messages` with `{ model, context, options }` — the model ID
 * only, never the Model record — and the response is an SSE stream of
 * `PiMessagesEvent`, a CLOSED union (`start` / `text_*` / `thinking_*` /
 * `toolcall_*` / `done` / `error`) with nothing vendor-shaped able to ride in
 * it. The container reconstructs `provider` / `api` / `model` from its own
 * local Model, never from the wire.
 *
 * ## What it does NOT do
 *
 * It mirrors no quirk table. The whole point is that `detectCompat` and every
 * per-vendor serializer keep running inside pi-ai, one process to the left of
 * the container: {@link handlePiMessagesRequest} rebuilds the REAL backing's
 * `Model` record and hands it to pi-ai's own `streamSimple`. A transcription
 * here would need a parity oracle to stay honest against every pi-ai release,
 * which is exactly the cost this design exists to avoid.
 *
 * ## Projection discipline
 *
 * The two event unions have the same ten variants, so mapping
 * `AssistantMessageEvent` → `PiMessagesEvent` is close to a mechanical field
 * drop. It is nevertheless written as a WHITELIST — every outbound event is
 * built field by field, and no inbound object is ever spread into an outbound
 * one — because a spread would ship the next pi-ai version's new field to the
 * container silently, and `partial` alone carries `api`, `provider` and the
 * real `model` id on every single event.
 */

import type { LlmProxyApiKeyConfig, ModelSwap, SidecarConfig } from "./helpers.ts";
import { LLM_PROXY_TIMEOUT_MS } from "./helpers.ts";
import { anthropicThinkingBudgets } from "@appstrate/core/model-generation";
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

/**
 * Default response cap when the platform resolved none for the backing.
 *
 * pi-ai's `buildBaseOptions` falls back to `model.maxTokens` whenever the
 * caller sends no cap of its own, so this number has to be a real one. 16384
 * is pi's OWN default for a model definition that declares no `maxTokens`
 * (`pi-coding-agent/dist/core/provider-composer.js`: `definition.maxTokens ??
 * 16384`), so an alias with unresolved limits lands exactly where a
 * pi-registered model with the same gap would.
 */
const PI_DEFAULT_MAX_TOKENS = 16_384;

/**
 * Zero per-token rates for the rebuilt `Model` — see {@link buildBackingModel}
 * for why this is deliberately not a price.
 */
const ZERO_RATES = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/** The same zeros in `Usage.cost` shape (which adds the `total` roll-up). */
const ZERO_USAGE_COST = { ...ZERO_RATES, total: 0 } as const;

/** Zero counts, for a turn that produced no usage report at all. */
const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { ...ZERO_USAGE_COST },
};

/** The `{ model, context, options }` body a `pi-messages` client POSTs. */
interface PiMessagesRequestBody {
  model: string;
  context: Context;
  options?: {
    temperature?: number;
    maxTokens?: number;
    reasoning?: ThinkingLevel;
    cacheRetention?: SimpleStreamOptions["cacheRetention"];
    sessionId?: string;
  };
}

/**
 * The pi-ai entry point this module drives. Injected rather than called
 * directly so a test can wrap it with pi-ai's own `onPayload` probe and assert
 * on the bytes actually originated (the repo bans `mock.module()`). Production
 * passes {@link streamBacking} from the sidecar's Pi SDK barrel.
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
  /** REAL (unmasked) token limits — the sidecar is trusted with them, the container is not. */
  limits: Pick<SidecarConfig, "modelContextWindow" | "modelMaxTokens">;
  /** Defaults to {@link streamBacking}. */
  streamBackingFn?: BackingStreamFn;
}

/**
 * Rebuild the pi-ai `Model` record of the REAL backing.
 *
 * `cost` is deliberately ZERO rather than the backing's published rate card.
 * pi-ai writes `usage.cost` from it on every settled turn, and that number
 * would then travel to the container inside the terminal `done` event — the
 * exact rate-card leak `MODEL_COST` was withheld to close (`buildRuntimePiEnv`).
 * Nothing depends on it: the platform prices the ledger row itself from
 * `runs.model_cost` × the reported token counts, and {@link projectUsage} drops
 * the field regardless. The SDK requires the shape, so zero is what it gets.
 */
export function buildBackingModel(deps: PiMessagesBackendDeps): Model<Api> {
  const { swap, llm, limits } = deps;
  const backing = swap.backing;
  if (!backing) {
    // Unreachable through the launcher — `parseModelSwapEnv` refuses a
    // re-originating descriptor with no backing catalog at boot, once, at the
    // cause. Restated here so this function has no implicit precondition.
    throw new Error("pi-messages backend: modelSwap.backing is required to re-originate");
  }
  return {
    id: swap.real,
    // Never surfaced: the projection drops `partial`, which is where pi-ai
    // puts the model record's identity fields.
    name: swap.real,
    api: swap.backingApiShape,
    // The load-bearing field. Together with `baseUrl` it is what pi-ai's
    // `detectCompat` reads to pick this vendor's request shape — precisely the
    // derivation the container no longer performs.
    provider: backing.providerId,
    baseUrl: llm.baseUrl,
    reasoning: backing.reasoning,
    ...(backing.reasoningLevelMap ? { thinkingLevelMap: backing.reasoningLevelMap } : {}),
    // Adaptive Anthropic backings. pi-ai gates its adaptive branch on
    // `compat.forceAdaptiveThinking`, which normally comes from its generated
    // metadata for a model it knows — and it does not know this one, because
    // the record is rebuilt from the platform's catalog rather than looked up.
    // Without the flag an adaptive model would receive the CLASSIC
    // `thinking: {type:"enabled", budget_tokens}` shape.
    //
    // The proxy path solves the same problem differently, by rewriting the
    // container's classic body into the adaptive one (`swapRequestModel`), and
    // needs a precomputed `effort` because the container built the body. Here
    // pi-ai builds it, so the effort comes from the backing's own
    // `thinkingLevelMap` — the presence of the descriptor is the whole signal.
    ...(swap.anthropicAdaptiveReasoning ? { compat: { forceAdaptiveThinking: true } } : {}),
    input: narrowInputModalities(backing.input),
    cost: { ...ZERO_RATES },
    // The REAL limits, not the ladder-rounded pair the container was given:
    // `maxTokens` reaches the upstream as the response cap and `contextWindow`
    // sizes pi-ai's own clamp, so rounding them here would cost capacity for no
    // opacity — the sidecar is trusted (`docs/architecture/MODEL_ALIASES.md`).
    // A zero window is pi-ai's own "do not clamp" sentinel
    // (`clampMaxTokensToContext` returns early on `<= 0`), which is the honest
    // reading of "the platform resolved no window for this model".
    contextWindow: limits.modelContextWindow ?? 0,
    maxTokens: limits.modelMaxTokens ?? PI_DEFAULT_MAX_TOKENS,
  };
}

/**
 * Narrow the platform's free-string modality list onto pi's closed pair.
 *
 * The same narrowing (and the same `["text"]` floor) that
 * `runtime-pi/env.ts`'s `parseModelInput` applies to the container's
 * `MODEL_INPUT`: an empty list would disable text as well as images, which is
 * never what an unrecognised entry meant.
 */
function narrowInputModalities(input: ReadonlyArray<string>): ("text" | "image")[] {
  const known = input.filter((m): m is "text" | "image" => m === "text" || m === "image");
  return known.length > 0 ? known : ["text"];
}

/**
 * The `options` members this boundary forwards upstream.
 *
 * The whitelist half of {@link projectRequestOptions}; {@link warnOnDiscardedRequestFields}
 * reports the difference against what actually arrived, so nothing can be
 * dropped in silence. Every member is portable vocabulary `pi-messages`
 * already models, so forwarding it grants the container nothing it could not
 * already ask for.
 */
export const FORWARDED_OPTION_KEYS: ReadonlySet<string> = new Set([
  "temperature",
  "maxTokens",
  "reasoning",
  "cacheRetention",
  "sessionId",
]);

/**
 * Log every field that reached this boundary and will NOT reach the backing.
 *
 * There is exactly one such field today — `toolChoice`, the sixth `options`
 * member a `pi-messages` client can populate — plus `debug`, which pi-ai puts
 * in the URL query rather than the body. Both are deliberate:
 *
 *   - `toolChoice`'s value space differs per vendor (`{type:"tool"}` for
 *     Anthropic vs `{type:"function"}` for the OpenAI family vs Mistral's
 *     `"any"`), so honouring it would mean the per-vendor mapping table this
 *     whole design exists to avoid. pi-coding-agent's session emits none today.
 *   - `debug` asks a backend for routing metadata about itself, which for an
 *     alias is the one thing this boundary exists not to answer.
 *
 * But "pi-coding-agent emits none today" is a fact about the installed version,
 * not an invariant, and a field that vanishes here would take a tool constraint
 * the agent asked for with it — with no error, no log, and nothing in the run to
 * find. So the drop is REPORTED rather than assumed away, and reported as a set
 * difference rather than a two-name blacklist, so an option a future pi-ai adds
 * is covered the day it appears.
 *
 * Warn, never reject: these fields are advisory in practice, and failing the
 * request would break every aliased run on a pi upgrade — strictly worse than
 * the gap it would close.
 *
 * Names FIELDS, never values or any model identifier: sidecar logs are
 * operator-visible and the alias contract holds there too.
 */
function warnOnDiscardedRequestFields(body: PiMessagesRequestBody, requestUrl: string): void {
  const discarded = Object.keys(body.options ?? {})
    .filter((key) => !FORWARDED_OPTION_KEYS.has(key))
    .map((key) => `options.${key}`);
  try {
    if (new URL(requestUrl).searchParams.has("debug")) discarded.push("query.debug");
  } catch {
    // An unparseable request URL is not this function's problem — the router
    // already matched on it. Report what the body alone showed.
  }
  if (discarded.length === 0) return;
  logger.warn(
    "pi-messages backend: request fields not forwarded to the backing " +
      "(vendor-specific or backend-introspective — see warnOnDiscardedRequestFields)",
    { discarded },
  );
}

/**
 * Vendor-neutral options forwarded from the client's `pi-messages` payload.
 *
 * The set is {@link FORWARDED_OPTION_KEYS}; anything else that arrived is
 * logged by {@link warnOnDiscardedRequestFields} rather than dropped silently.
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
    ...(incoming.cacheRetention !== undefined ? { cacheRetention: incoming.cacheRetention } : {}),
    ...(incoming.sessionId !== undefined ? { sessionId: incoming.sessionId } : {}),
    // Applied HERE and nowhere upstream of here. A classic (non-adaptive)
    // Anthropic call needs a request-scoped thinking budget, and pi's built-in
    // table collapses `xhigh` and `max` onto one slot — but `PiMessagesOptions`
    // models no budget at all, so the container cannot send one. `pi-runner`
    // applies the same core rule on the direct path; without this branch an
    // aliased Anthropic run would silently drop to pi's defaults.
    ...(swap.backingApiShape === "anthropic-messages" && incoming.reasoning !== undefined
      ? { thinkingBudgets: anthropicThinkingBudgets(incoming.reasoning) }
      : {}),
  };
}

/**
 * Token counts for the terminal event, rebuilt field by field.
 *
 * The platform prices the run's ledger row from exactly these four buckets
 * (`apps/api/test/unit/runner-cost-parity.test.ts` pins the formula), so
 * dropping any of them would lose the bill. The two OPTIONAL `Usage` members
 * are dropped instead, both for the same reason: each is a vendor tell that
 * costs nothing to lose. pi-ai's own comments say `cacheWrite1h` is "[o]nly
 * Anthropic reports this split" and that `reasoning` is "left undefined by
 * providers that don't" expose a breakdown, so their mere presence narrows the
 * candidate vendor. Neither is priced — the platform charges all
 * cache-creation tokens at the cache-write rate, and reasoning tokens are
 * already counted inside `output`.
 *
 * `cost` is zeroed for the same reason `Model.cost` is; see
 * {@link buildBackingModel}.
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
 * inbound event does not carry a field the outbound one declares: pi-ai's
 * `toolcall_start` has no `id` / `toolName`, and its `text_end` /
 * `thinking_end` carry no signature. That read is itself a whitelist — named
 * fields off a known content block, never the block itself.
 *
 * Returns `undefined` for an event with no wire counterpart, which today is
 * only `done` with `reason: "deferred"`. Deferred responses are a batch-API
 * capability the client cannot request (`PiMessagesOptions` has no `deferred`
 * flag) and this backend never enables, so there is no terminal to forward;
 * the caller turns it into the neutral error terminal rather than ending the
 * stream with no terminal at all.
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
      // `event.error.errorMessage` is pi-ai prose that interpolates
      // `model.provider` on several paths (`No API key provided for provider
      // "<x>"`, `<x> response has no body`) and carries whatever the vendor's
      // SDK wrote on the rest. Same posture as every other alias error surface:
      // REPLACE it, never forward-and-scrub. The caller supplies the neutral
      // text, which is why this case returns the reason and usage only.
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
 * re-originate the call through pi-ai against the real backing, and stream the
 * projected events back.
 *
 * Once the body parses the response is always 200 + SSE, because that is what
 * the client's own protocol expects: pi-ai's `pi-messages` reader treats a
 * non-2xx as a transport failure and never reaches the terminal event, so an
 * upstream refusal has to arrive as an `error` EVENT for the agent to see a
 * failed turn rather than an opaque one. A body that does not parse never got
 * as far as a stream, so it answers with the neutral HTTP envelope instead.
 *
 * The client's `model` field is ignored, not swapped: this boundary builds the
 * upstream request from the swap descriptor's real id, so there is no alias
 * left in the body to rewrite (and nothing the container sends could redirect
 * the call at a different model).
 */
export function handlePiMessagesRequest(
  deps: PiMessagesBackendDeps,
  request: Request,
  bodyText: string,
): Response {
  const { swap } = deps;

  const body = parseRequestBody(bodyText);
  if (typeof body === "string") {
    // The reason names the CLIENT's malformed body, never the backing, so it
    // is safe to log verbatim; the caller-facing envelope stays neutral.
    logger.warn("pi-messages backend: unusable request body", { reason: body });
    return new Response(syntheticAliasErrorBody(swap, 400), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  warnOnDiscardedRequestFields(body, request.url);

  const model = buildBackingModel(deps);
  const stream = deps.streamBackingFn ?? streamBacking;

  // The same absolute deadline the proxy path applies to an LLM stream, plus
  // the client's own disconnect. `AbortSignal.any` so whichever fires first
  // unwinds pi-ai's fetch instead of leaving the upstream call orphaned.
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
            // Neutral prose attached here rather than inside the projection, so
            // the projection never has to read the alias descriptor.
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
        // the stream machinery itself broke. Log the detail — server-side only,
        // it can name the backing — and fall through to the synthesized
        // terminal below.
        logger.warn("pi-messages backend: upstream stream threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!terminal) {
        // Either the loop broke above, or pi-ai ended without a terminal event
        // (its own `stream ended without a terminal event` guard normally
        // converts that into an error event, so this is belt-and-braces). The
        // client MUST see a terminal: `pi-messages` reconstructs the assistant
        // message from it, and its absence hangs the turn.
        terminal = {
          type: "error",
          reason: "error",
          usage: projectUsage(EMPTY_USAGE),
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
