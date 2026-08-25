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
import {
  LLM_STREAM_IDLE_TIMEOUT_MS,
  llmUpstreamAbort,
  withIdleBound,
  STREAM_IDLE,
} from "./helpers.ts";
import { anthropicThinkingBudgets } from "@appstrate/core/model-generation";
import { PI_SDK_VERSION, PI_SDK_VERSION_HEADER } from "@appstrate/runner-pi/provider-map";
import { PLATFORM_MODEL_COMPAT, ZERO_MODEL_COST } from "@appstrate/runner-pi/model-compat";
import { logger } from "./logger.ts";
import {
  syntheticAliasErrorBody,
  syntheticAliasErrorMessage,
  projectAliasUpstreamStatus,
  ALIAS_COLLAPSED_UPSTREAM_STATUS,
} from "./model-swap.ts";
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

/**
 * The zeros of {@link ZERO_MODEL_COST} in `Usage.cost` shape (which adds the
 * `total` roll-up). Here they are load-bearing opacity, not filler — see
 * {@link buildBackingModel} and the constant's own docblock.
 */
const ZERO_USAGE_COST = { ...ZERO_MODEL_COST, total: 0 } as const;

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
  /**
   * Inter-chunk idle bound on the re-originated stream. Defaults to
   * {@link LLM_STREAM_IDLE_TIMEOUT_MS} (where the operator override is read);
   * injected by `app.ts` from `AppDeps.llmStreamIdleTimeoutMs` so tests need
   * not wait two real minutes.
   */
  llmStreamIdleTimeoutMs?: number;
  /**
   * Transport the re-originated call uses. Defaults to the global `fetch`;
   * {@link createUpstreamStatusProbe} always wraps it, so this is the base of
   * that wrapper, never a replacement for it.
   *
   * A test injects it here rather than through `streamBackingFn`'s `options`:
   * an `options.fetch` supplied by the caller would DISPLACE the status probe
   * instead of feeding it, and the retry budget + the observed upstream status
   * are precisely what has to be exercised through REAL pi-ai (this repo bans
   * `mock.module()`, and a hand-rolled stream double reproduces neither).
   */
  fetchImpl?: typeof fetch;
}

/**
 * Provider-level retry budget for the re-originated call.
 *
 * The sidecar is the ONLY side of an aliased run that can see the backing's
 * `retry-after` / `retry-after-ms` headers: the container speaks `pi-messages`,
 * a closed event union with no header channel at all, so the backoff a
 * throttling provider ASKS for is legible here and nowhere else. pi-ai's
 * `retryProviderRequest` honours those headers — but only when it is given a
 * budget, and its `options.maxRetries ?? 0` makes an unset field mean "never
 * retry" (`@earendil-works/pi-ai/dist/utils/provider-retry.js`). Leaving it
 * unset is why an aliased run used to spend zero attempts on a `429`.
 *
 * Two, matching the pinned OpenAI/Anthropic SDK default pi-ai reproduces. It
 * COMPOSES with the container's turn-level budget (`packages/runner-pi`), which
 * restarts the whole assistant turn rather than the HTTP call. The product of
 * the two is bounded, and not by arithmetic: every attempt here shares ONE
 * `llmUpstreamAbort` signal, so the retries fit inside that call's 60 s TTFB
 * window (see {@link ALIAS_MAX_RETRY_DELAY_MS}) and the exchange as a whole
 * inside its 30 min absolute cap.
 */
const ALIAS_UPSTREAM_MAX_RETRIES = 2;

/**
 * Cap on a server-REQUESTED retry delay. pi-ai fails the request immediately
 * when `retry-after` asks for more, which is what this path wants: the TTFB
 * bound in `llmUpstreamAbort` (60 s by default) is measured from the FIRST
 * attempt and is not reset by a backoff sleep, so a multi-minute `retry-after`
 * honoured here would be killed by that timer with nothing to show for the
 * wait. Failing fast hands the container a retryable terminal instead, and its
 * turn-level budget — which carries no TTFB bound — absorbs the long wait.
 */
const ALIAS_MAX_RETRY_DELAY_MS = 10_000;

/**
 * The two statuses this sidecar attributes to a failure of its OWN making
 * (as opposed to one the backing reported). Both are gateway statuses because
 * that is exactly what the sidecar is on this path: it terminated the client's
 * protocol and re-originated upstream, so "I could not reach the backing" is a
 * 502 and "the backing went silent on me" is a 504.
 *
 * The unreachable status IS core's {@link ALIAS_COLLAPSED_UPSTREAM_STATUS}
 * rather than a second literal `502` — the two must move together (a caller
 * cannot tell "the sidecar could not reach the backing" from "the backing
 * answered something too vendor-specific to forward", and both must stay
 * retryable under pi-ai's classifier), and a magic number one package away
 * from the constant it has to equal is exactly the drift this boundary exists
 * to prevent.
 */
const SIDECAR_UPSTREAM_UNREACHABLE_STATUS = ALIAS_COLLAPSED_UPSTREAM_STATUS;
const SIDECAR_UPSTREAM_IDLE_STATUS = 504;

/** Records the status of the last upstream response of one re-originated call. */
interface UpstreamStatusProbe {
  /** The transport handed to pi-ai — delegates verbatim, records the status. */
  fetch: typeof fetch;
  /**
   * The status a failed turn should report, or `undefined` when there is
   * nothing honest to report:
   *
   *   - the backing answered with an error status → that status when
   *     {@link projectAliasUpstreamStatus} forwards it (generic enough to name
   *     no vendor, and terminal-vs-transient preserved — this is what makes a
   *     `429` retryable in the container again), otherwise
   *     {@link SIDECAR_UPSTREAM_UNREACHABLE_STATUS};
   *   - nothing ever answered — DNS, connect, TLS, an aborted fetch →
   *     {@link SIDECAR_UPSTREAM_UNREACHABLE_STATUS};
   *   - the backing answered 2xx and the turn failed AFTER that (a truncated
   *     stream, a `finish_reason` the provider calls an error) → `undefined`.
   *     That failure has no HTTP status, and fabricating one would tell the
   *     container's retry classifier something this boundary does not know.
   */
  failureStatus: () => number | undefined;
}

/**
 * Wrap `base` so the status of each upstream response is observable after the
 * fact. pi-ai's `error` event carries an `AssistantMessage`, which models no
 * status at all — and its `errorMessage`, the one place the status sometimes
 * appears, is vendor prose this boundary must replace rather than parse. The
 * transport is therefore the only vendor-neutral place the number is legible.
 *
 * The LAST response wins: with {@link ALIAS_UPSTREAM_MAX_RETRIES} in play a
 * turn can make several upstream calls, and the one that decided the outcome
 * is the one that ran last.
 */
function createUpstreamStatusProbe(base: typeof fetch): UpstreamStatusProbe {
  let observed: number | undefined;
  return {
    // `typeof fetch` (Bun) carries a static `preconnect` beside the call
    // signature, and pi-ai's `FetchFunction` demands the whole shape. Forward
    // the real member rather than casting it away, so the probe stays a
    // faithful drop-in — the same idiom `integrations-boot.ts` uses.
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
        const response = await base(input, init);
        observed = response.status;
        return response;
      },
      { preconnect: base.preconnect },
    ),
    failureStatus: () => {
      if (observed === undefined) return SIDECAR_UPSTREAM_UNREACHABLE_STATUS;
      if (observed < 400) return undefined;
      // One home for the projection, shared with the platform gateway: a
      // vendor- or CDN-specific code names the backing as surely as its prose.
      return projectAliasUpstreamStatus(observed);
    },
  };
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
    cost: { ...ZERO_MODEL_COST },
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
  upstreamFetch: typeof fetch,
): SimpleStreamOptions {
  const incoming = body.options ?? {};
  return {
    apiKey,
    signal,
    fetch: upstreamFetch,
    // NOT part of the client's payload and deliberately not derived from it:
    // the retry budget is this boundary's, because this boundary is the only
    // one that can read the backing's `retry-after`. See the constants.
    maxRetries: ALIAS_UPSTREAM_MAX_RETRIES,
    maxRetryDelayMs: ALIAS_MAX_RETRY_DELAY_MS,
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

  // The same deadlines the non-aliased `/llm/*` forward applies — the 30 min
  // absolute cap, the 60 s first-response bound and the inter-chunk idle bound
  // — combined with the client's disconnect; whichever fires first unwinds
  // pi-ai's fetch.
  //
  // `pi-messages` is one of the four api shapes that IGNORE pi-ai's own
  // `timeoutMs` (grep `timeoutMs` in `@earendil-works/pi-ai/dist/api/`), and
  // the BACKING re-originated here can be another one of them, so on this path
  // `options.signal` is the only deadline that exists at all.
  //
  // We never see HTTP headers here (pi-ai owns the fetch), so the first event
  // yielded by the generator is the equivalent liveness proof, and that is
  // where `firstResponse()` disarms the TTFB timer — before it can abort a
  // healthy long stream. The `finally` is the belt: a throw before the first
  // event must not leave a 60 s timer armed either.
  //
  // `unwind` is how this path RELEASES the upstream. The loop below detects a
  // stall (a pending `next()` is the same shape of pending promise as a pending
  // `read()`), but detection alone leaves pi-ai's fetch in flight until the
  // 30 min cap; aborting is what frees the socket. Fired on every exit, not
  // just the idle one — on a normal `done` the fetch has already finished, so
  // it is a no-op there.
  const unwind = new AbortController();
  const idleTimeoutMs = deps.llmStreamIdleTimeoutMs ?? LLM_STREAM_IDLE_TIMEOUT_MS;
  const abort = llmUpstreamAbort(AbortSignal.any([request.signal, unwind.signal]));
  // Per REQUEST, never per process: the recorded status belongs to this turn.
  const statusProbe = createUpstreamStatusProbe(deps.fetchImpl ?? fetch);
  const upstream = stream(
    model,
    body.context,
    projectRequestOptions(body, swap, deps.llm.apiKey, abort.signal, statusProbe.fetch),
  );

  const encoder = new TextEncoder();
  const sse = new ReadableStream<Uint8Array>({
    async start(controller) {
      let terminal: PiMessagesEvent | undefined;
      // Manual iteration, not `for await`: the idle bound has to be armed
      // against the PENDING `next()` and cleared the moment it settles, which
      // `for await` gives no seam for. Same instrument as `passUpstream`'s
      // `reader.read()` — and same reason it cannot be a long-lived timer: it
      // must measure only the window where we are waiting and the upstream is
      // silent.
      const iterator = upstream[Symbol.asyncIterator]();
      try {
        for (;;) {
          const outcome = await withIdleBound(iterator.next(), idleTimeoutMs);
          if (outcome === STREAM_IDLE) {
            // Server-side only, so it may name the backing.
            logger.warn("pi-messages backend: upstream went silent mid-stream", {
              idleTimeoutMs,
              real: swap.real,
            });
            terminal = {
              type: "error",
              reason: "error",
              usage: EMPTY_USAGE,
              // 504, not the backing's last status: the stall is THIS hop's
              // verdict on the exchange, and it is unambiguously transient —
              // which is the whole point of carrying a status here.
              errorMessage: syntheticAliasErrorMessage(swap, SIDECAR_UPSTREAM_IDLE_STATUS),
            };
            break;
          }
          if (outcome.done) break;
          // Liveness proof — see `llmUpstreamAbort` above. `clearTimeout` is
          // idempotent, so calling it per event is cheaper than tracking a
          // "first" flag.
          abort.firstResponse();
          const projected = projectAssistantEvent(outcome.value);
          if (!projected) continue;
          if (projected.type === "error") {
            // Attached here so the projection never reads the alias descriptor.
            // The STATUS travels with it: it is the only thing in the replaced
            // message the container's retry classifier can act on, and it names
            // no vendor — see {@link syntheticAliasErrorMessage}.
            terminal = {
              ...projected,
              errorMessage: syntheticAliasErrorMessage(swap, statusProbe.failureStatus()),
            };
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
      } finally {
        abort.firstResponse();
        // Release the upstream: the abort unwinds pi-ai's in-flight fetch,
        // `return()` finishes the generator that `for await` would have closed
        // for us. Both are no-ops once the stream has ended on its own.
        unwind.abort(new Error("pi-messages backend: releasing the upstream stream"));
        void Promise.resolve(iterator.return?.()).catch(() => {});
      }
      if (!terminal) {
        // The client MUST see a terminal: `pi-messages` reconstructs the
        // assistant message from it, and its absence hangs the turn.
        terminal = {
          type: "error",
          reason: "error",
          usage: EMPTY_USAGE,
          // Reached when the generator ended with no terminal, or the stream
          // machinery threw. Whatever the probe saw still describes it best: a
          // status the backing reported, or 502 for "never got that far".
          errorMessage: syntheticAliasErrorMessage(swap, statusProbe.failureStatus()),
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
