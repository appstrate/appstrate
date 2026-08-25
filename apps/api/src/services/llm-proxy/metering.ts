// SPDX-License-Identifier: Apache-2.0

/**
 * Response-forwarding + usage-metering for the `/api/llm-proxy/*` surfaces
 * (the protocol-adapter core, {@link proxyLlmCall}):
 *
 *   - strip `content-encoding`/`content-length` from the forwarded headers
 *     (Bun's `fetch` already decompressed the body, so echoing the upstream
 *     encoding would make the caller re-decode plaintext → ZlibError);
 *   - tap the teed SSE stream to extract usage WITHOUT buffering the whole
 *     response;
 *   - insert a usage row whose cost is Σ(tokens × cost/1e6), handing transient
 *     DB failures to the durable usage-retry queue.
 *
 * Accounting invariant: EVERY 2xx upstream reply produces exactly one ledger
 * row. When usage cannot be parsed (interrupted SSE tap, non-JSON body, a
 * provider that emitted no usage frame) the row is written with zero tokens and
 * a marked `request_id` — see {@link UNPARSED_USAGE_REQUEST_ID_PREFIX}. Upstream
 * ERRORS (non-2xx) are the only un-metered branch: no tokens were produced.
 */

import { logger } from "../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { computeTokenCost } from "@appstrate/afps-runtime/runner";
import { recordLlmUsageReliably } from "../llm-usage-retry.ts";
import { resolvePricingStatus } from "../pricing-provenance.ts";
import type { LlmUsageEntry } from "../llm-usage-ledger.ts";
import type { ModelCost } from "@appstrate/core/module";
import type { ModelSwap } from "@appstrate/core/sidecar-types";
import {
  swapResponseModelJson,
  createSseModelSwapStream,
  syntheticAliasErrorBody,
  LLM_PASSTHROUGH_RESPONSE_HEADERS,
} from "@appstrate/core/model-swap";
import {
  stripUpstreamResponseHeaders,
  withIdleBound,
  STREAM_IDLE,
} from "@appstrate/connect/proxy-primitives";
import type { ResolvedModel } from "../org-models.ts";
import { storeResponse } from "./response-cache.ts";
import { LLM_STREAM_IDLE_TIMEOUT_MS } from "./helpers.ts";
import type { LlmProxyAdapter, LlmProxyPrincipal, UpstreamUsage } from "./types.ts";

/** Clone upstream response headers, dropping hop-by-hop + stale content encoding/length. */
const cloneResponseHeaders = stripUpstreamResponseHeaders;

/**
 * Client-facing response headers for one upstream reply.
 *
 * No swap → the permissive {@link cloneResponseHeaders} (unchanged behavior).
 * That clone forwards `server: cloudflare`, `cf-ray`, `anthropic-*`,
 * `openai-organization`, … — headers that fingerprint the backing provider
 * even when every body field is swapped. An aliased model therefore gets only
 * the shared allowlist ({@link LLM_PASSTHROUGH_RESPONSE_HEADERS} — same
 * posture as the sidecar), copying just the entries present upstream.
 */
function buildClientHeaders(upstream: Headers, swap: ModelSwap | null | undefined): Headers {
  if (!swap) return cloneResponseHeaders(upstream);
  const headers = new Headers();
  for (const name of LLM_PASSTHROUGH_RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

/**
 * Synthesized neutral error response for an aliased model — the upstream
 * body never reaches the caller (see {@link syntheticAliasErrorBody});
 * `reason` and `logFields` carry the server-side detail instead.
 */
function syntheticAliasErrorResponse(
  swap: ModelSwap,
  upstream: Headers,
  status: number,
  reason: string,
  logFields: Record<string, unknown>,
): Response {
  logger.warn(reason, logFields);
  const headers = buildClientHeaders(upstream, swap);
  // The synthesized body is JSON even when the upstream's wasn't.
  headers.set("content-type", "application/json");
  return new Response(syntheticAliasErrorBody(swap, status), { status, headers });
}

/**
 * Upper bound on usage-bearing frames retained by {@link tapSseUsage}.
 * Real providers emit at most two (Anthropic: `message_start` + terminal
 * `message_delta`; OpenAI-compatible: the terminal frame when
 * `stream_options.include_usage` is set). The cap only guards against a
 * pathological upstream stamping usage on every frame.
 */
const MAX_RETAINED_USAGE_FRAMES = 64;

/**
 * Upper bound on the partial-frame buffer held by {@link tapSseUsage} between
 * SSE delimiters. A malformed / adversarial upstream that never emits the
 * `\n\n` frame delimiter would otherwise accumulate the whole response into a
 * single unbounded string (memory-exhaustion DoS, one per in-flight stream).
 * Usage frames are a few hundred bytes; 1 MB is orders of magnitude of
 * headroom, so exceeding it means the pending fragment is not a usage frame
 * and can be safely discarded.
 */
const MAX_TAP_BUFFER_BYTES = 1_000_000;

/**
 * Tap a teed SSE stream and extract usage WITHOUT retaining the full response
 * (accumulating every frame would be O(response) memory per in-flight
 * stream). Frames are parsed as delimited; only frames that individually
 * yield usage (probed via `adapter.parseSseUsage([frame])`) are retained, in
 * arrival order, and the adapter extracts the final result from that subset —
 * behaviour-identical to scanning every frame for either shipped adapter.
 *
 * IDLE BOUND — the same one {@link guardSseTeardown} applies to the CLIENT
 * branch, and it has to be here too. `tee()` cancels its source only once BOTH
 * branches are cancelled, so bounding the client branch alone left this tap
 * holding a pending `read()` forever: the upstream socket, its body and this
 * promise stayed pinned with no absolute deadline behind them (`guardedFetch`
 * detaches its timer at the headers). It also broke the module's accounting
 * invariant — a tap that never finishes never calls `meter`, so a stalled 2xx
 * produced no ledger row at all. On expiry the tap returns what it managed to
 * parse (usually `null`), which the caller meters as an unparsed-usage row.
 */
export async function tapSseUsage(
  stream: ReadableStream<Uint8Array>,
  adapter: LlmProxyAdapter,
  idleTimeoutMs: number = LLM_STREAM_IDLE_TIMEOUT_MS,
): Promise<UpstreamUsage | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const usageFrames: string[] = [];
  const considerFrame = (frame: string): void => {
    if (adapter.parseSseUsage([frame]) === null) return;
    if (usageFrames.length >= MAX_RETAINED_USAGE_FRAMES) {
      // Keep the FIRST retained frame (Anthropic's `message_start` seeds
      // input/cache tokens) and the newest tail; drop the oldest intermediate
      // — both adapters let later frames supersede it.
      usageFrames.splice(1, 1);
    }
    usageFrames.push(frame);
  };
  try {
    for (;;) {
      const outcome = await withIdleBound(reader.read(), idleTimeoutMs);
      if (outcome === STREAM_IDLE) {
        logger.warn("llm-proxy: SSE usage tap idle timeout — metering what was parsed", {
          idleTimeoutMs,
        });
        // Releasing THIS branch is half of what cancels the tee'd source; the
        // client branch releases the other half in `guardSseTeardown`.
        void reader.cancel(new Error("llm-proxy: SSE idle timeout")).catch(() => {});
        break;
      }
      const { value, done } = outcome;
      if (done) break;
      if (value) buffer += decoder.decode(value, { stream: true });
      // Split on SSE frame delimiter (blank line). Keep the tail in the
      // buffer until the next chunk — a frame may straddle chunks.
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        considerFrame(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
      // Bound the pending partial-frame buffer: a stream with no frame
      // delimiter must not grow the buffer without limit. A usage frame is
      // tiny, so an over-cap fragment is non-usage data — drop it.
      if (buffer.length > MAX_TAP_BUFFER_BYTES) buffer = "";
    }
    if (buffer.trim().length > 0) considerFrame(buffer);
  } catch (err) {
    logger.warn("llm-proxy: stream tap read failed — usage not recorded", {
      error: getErrorMessage(err),
    });
    return null;
  }
  return adapter.parseSseUsage(usageFrames);
}

export interface RecordUsageInputs {
  principal: LlmProxyPrincipal;
  runId: string | null;
  /**
   * Chat session this call belongs to, propagated from the VALIDATED loopback
   * bearer's claims (never a spoofable header). Only set for chat's built-in
   * proxy-routed turns; null for headless/CLI proxy calls.
   */
  chatSessionId: string | null;
  /** The Appstrate preset id (org model row id) — stored as `llm_usage.model`. */
  presetId: string;
  resolved: ResolvedModel;
  usage: UpstreamUsage | null;
  durationMs: number;
}

/**
 * Prefix stamped on the `request_id` of a row recorded for a 2xx upstream reply
 * whose usage could NOT be parsed (SSE tap interrupted, non-JSON body, provider
 * that emitted no usage frame). `request_id` is a server-side dedup key that no
 * consumer parses, which makes it the one place a marker can live without a
 * schema change — `SELECT … WHERE request_id LIKE 'usage-unparsed:%'` gives ops
 * the exact list of paid-but-unpriced calls.
 */
export const UNPARSED_USAGE_REQUEST_ID_PREFIX = "usage-unparsed:";

/**
 * Insert one `llm_usage` row (source="proxy") via the single ledger writer.
 * A transient DB failure is durably queued with the same request id; if BOTH
 * Postgres and the retry queue are unavailable, the error propagates instead of
 * silently losing billable usage.
 *
 * A 2xx reply with NO parseable usage still writes a row — zero tokens, zero
 * cost, `request_id` marked with {@link UNPARSED_USAGE_REQUEST_ID_PREFIX}. The
 * provider was paid for that call; recording nothing made it invisible to
 * `runs.cost` AND to the billing cursor, so the platform could not even count
 * how much it was blind to. An accountable zero row is auditable; silence is
 * not.
 *
 * `writeEntry` is the ledger seam — the durable proxy write by default, injected
 * by tests that assert the SHAPE of the row this function builds.
 */
export async function recordProxyUsage(
  inputs: RecordUsageInputs,
  writeEntry: (entry: LlmUsageEntry) => Promise<void> = (entry) =>
    recordLlmUsageReliably(entry, { onConflict: "proxy-idempotent" }),
): Promise<void> {
  const unparsed = inputs.usage === null;
  if (unparsed) {
    logger.error("llm-proxy: successful response contained no parseable usage", {
      orgId: inputs.principal.orgId,
      presetId: inputs.presetId,
      runId: inputs.runId,
      credentialSource: inputs.resolved.isSystemModel ? "system" : "org",
    });
  }
  const usage: UpstreamUsage = inputs.usage ?? { inputTokens: 0, outputTokens: 0 };

  // Provenance of the cost below, classified from the SAME inputs the cost is
  // computed from. The `usage-unparsed:` row is classified identically, on
  // purpose: `pricing_status` answers "did the platform have rates for this
  // model", which is orthogonal to "could the reply's usage be parsed". The two
  // failures must stay separable — the parse gap already has its own marker on
  // `request_id` (see {@link UNPARSED_USAGE_REQUEST_ID_PREFIX}), so folding it
  // into this column would destroy one signal to restate another. A zero-token
  // row on an unpriced model is therefore `unpriced`, which is the honest
  // reading: no rates existed, whatever the token counts turned out to be.
  const pricingStatus = resolvePricingStatus({
    orgId: inputs.principal.orgId,
    model: inputs.presetId,
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cacheReadTokens ?? 0,
      cache_creation_input_tokens: usage.cacheWriteTokens ?? 0,
    },
    cost: inputs.resolved.cost ?? null,
    context: { source: "proxy", runId: inputs.runId, realModel: inputs.resolved.modelId },
  });

  await writeEntry({
    source: "proxy",
    orgId: inputs.principal.orgId,
    apiKeyId: inputs.principal.kind === "api_key" ? inputs.principal.apiKeyId : null,
    userId: inputs.principal.kind === "jwt_user" ? inputs.principal.userId : null,
    // Attribution invariant: `runId` must reference a run in
    // `principal.orgId` — the route validates the caller-supplied
    // `X-Run-Id` before the upstream call (`assertRunAttributable`), and
    // the composite FK `llm_usage(run_id, org_id) → runs(id, org_id)`
    // enforces it structurally for every new row. A row is attributed to at
    // most one context (ledger check `llm_usage_context_single`), so a
    // run-pinned call never also carries a chat session id — runId wins.
    runId: inputs.runId,
    chatSessionId: inputs.runId ? null : inputs.chatSessionId,
    model: inputs.presetId,
    realModel: inputs.resolved.modelId,
    api: inputs.resolved.apiShape,
    // Which credential set reached the provider: platform (system) models vs
    // the org's own key. The resolved model already carries the flag.
    credentialSource: inputs.resolved.isSystemModel ? "system" : "org",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? null,
    cacheWriteTokens: usage.cacheWriteTokens ?? null,
    costUsd: computeCostUsd(usage, inputs.resolved.cost ?? null),
    pricingStatus,
    durationMs: inputs.durationMs,
    // Stable across durable retries. `proxy-idempotent` maps an uncertain
    // post-commit acknowledgement to a no-op on replay.
    requestId: unparsed
      ? `${UNPARSED_USAGE_REQUEST_ID_PREFIX}${crypto.randomUUID()}`
      : crypto.randomUUID(),
  });
}

export function computeCostUsd(usage: UpstreamUsage, cost: ModelCost | null): number {
  // Delegate to the shared per-token formula (`@appstrate/afps-runtime/runner`)
  // so the proxy meter and the codex runner can't drift (D1). `UpstreamUsage`
  // is camelCase; map it onto the snake_case `TokenUsage` the helper consumes.
  return computeTokenCost(
    {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cacheReadTokens ?? 0,
      cache_creation_input_tokens: usage.cacheWriteTokens ?? 0,
    },
    cost,
  );
}

/** Per-call metering context for {@link forwardMeteredResponse}. */
export interface MeteredForwardContext {
  principal: LlmProxyPrincipal;
  runId: string | null;
  /** Chat session (from the validated loopback token) — see {@link RecordUsageInputs.chatSessionId}. */
  chatSessionId: string | null;
  /** The Appstrate preset id (stored as `llm_usage.model`). */
  presetId: string;
  resolved: ResolvedModel;
  /** `Date.now()` captured just before the upstream fetch (for `durationMs`). */
  started: number;
}

/** Per-call knobs of {@link forwardMeteredResponse}. */
interface MeteredForwardOptions {
  /**
   * Model-alias swap (issue #727). When set, the real upstream id echoed by the
   * upstream is rewritten back to the alias on the success branches (SSE
   * frames, JSON body), upstream error bodies are REPLACED with a synthetic
   * neutral envelope, and response headers are reduced to the shared allowlist
   * — so the caller never sees the backing model. The usage tap reads the
   * untouched stream, so accounting still sees the real id. `null` forwards
   * verbatim — a non-aliased preset has nothing to swap.
   */
  swap?: ModelSwap | null;
  /**
   * Response-cache write for a non-streaming 2xx reply. When set, the forwarded
   * (already alias-swapped) body is persisted and the `x-llm-proxy-cache-status:
   * MISS` header is stamped. `null` → no caching (the sole caller always
   * passes the field; it is `null` whenever no cache key was resolved).
   */
  cache?: { cacheKey: string; ttlSeconds: number } | null;
  /**
   * Ledger writer. Defaults to {@link recordProxyUsage} (the single ledger
   * writer); injected by tests that exercise the forwarding branches without a
   * database. Every 2xx branch calls it exactly once — including the ones that
   * could not parse usage, which is what makes a paid call impossible to lose.
   */
  recordUsage?: (inputs: RecordUsageInputs) => Promise<void>;
}

/** `controller.close()` throws if the stream is already closed/errored (e.g. the
 * consumer cancelled mid-pull). That is not a teardown — swallow it. */
function closeSafely(controller: ReadableStreamDefaultController<Uint8Array>): void {
  try {
    controller.close();
  } catch {
    // already closed/errored — nothing to do
  }
}

/**
 * Wrap an SSE source so a teardown that rejects/throws AFTER the response
 * headers are already on the wire is caught HERE — at the seam we own —
 * instead of escaping the request lifecycle as an unhandled rejection.
 *
 * Context: the upstream body is `tee()`d into a client branch and a metering
 * branch. The metering tap is already guarded (its `.catch` logs + no-ops).
 * The client branch — returned as the `Response` body, sometimes
 * `pipeThrough`-swapped for model aliases — was not. When an upstream gateway
 * breaks mid-flux the `tee()` branch rejects with no request `try/catch` left
 * to catch it. On a single-process multi-tenant server that lands as a
 * process-level `unhandledRejection` — one tenant's broken stream threatening
 * every tenant.
 *
 * IMPORTANT — wrap BEFORE the alias-swap `pipeThrough`, not after. The guarded
 * wrapper never errors (it closes cleanly on an upstream reject), so the
 * internal `pipeTo` that `pipeThrough` runs sees a normal close instead of a
 * rejected abort. That removes the leak regardless of whether the runtime
 * marks `pipeThrough`'s internal pipe promise `[[handled]]` — guarding the
 * consumer read alone would not. The swap transform then flushes its buffered
 * partial line on that clean close.
 *
 * `pull` is demand-driven, so backpressure is preserved and nothing is
 * buffered. `onTeardownError` fires for a genuine upstream read rejection and
 * for an inter-chunk idle timeout — never for a consumer-cancel close race
 * (those are swallowed).
 *
 * IDLE BOUND — read before touching. `idleTimeoutMs` caps how long the UPSTREAM
 * may stay silent between two chunks. Because `pull` is demand-driven, the
 * timer must be armed against the PENDING `reader.read()` and cleared the
 * moment it settles: that promise is pending exactly while the upstream is
 * silent AND the consumer is waiting for a chunk. A stream-level watchdog, or
 * any timer that keeps running between pulls, would instead kill a merely SLOW
 * CONSUMER on a healthy upstream — a browser tab throttled in the background is
 * enough to trip it. Do not "simplify" it into one long-lived timer.
 *
 * WHY EXPIRY IS A TEARDOWN-ERROR-AND-CLEAN-CLOSE, NOT A STREAM ERROR: the
 * invariant this whole function exists to hold is that the guarded stream NEVER
 * errors. It is wrapped BEFORE the alias-swap `pipeThrough`, and an erroring
 * source there re-creates precisely the unhandled-rejection leak documented
 * above — one tenant's stalled provider taking down a multi-tenant process.
 * Erroring on idle would trade a bug for the same bug with a nicer message. The
 * signal is not lost: `onTeardownError` logs it at the call site, and the
 * caller sees the same truncated SSE stream an upstream reject already
 * produces. That is the best achievable at this seam.
 */
export function guardSseTeardown(
  source: ReadableStream<Uint8Array>,
  onTeardownError: (err: unknown) => void,
  idleTimeoutMs: number = LLM_STREAM_IDLE_TIMEOUT_MS,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: Awaited<ReturnType<typeof reader.read>> | typeof STREAM_IDLE;
      try {
        result = await withIdleBound(reader.read(), idleTimeoutMs);
      } catch (err) {
        // The only genuine teardown signal: the upstream/tee branch rejected
        // mid-flux. Report once, then close the client stream cleanly (the
        // caller sees a truncated SSE stream — the best achievable here).
        onTeardownError(err);
        closeSafely(controller);
        return;
      }
      if (result === STREAM_IDLE) {
        // Four of the ten api shapes this platform maps ignore pi-ai's own
        // `timeoutMs`, so this proxy is the only provider-agnostic place a
        // stalled stream can be caught at all.
        //
        // THIS MESSAGE NEVER LEAVES THE SERVER: `onTeardownError` is a logger
        // call at its only call site (`forwardMeteredResponse` below), and by
        // this module's own contract the client stream closes CLEANLY rather
        // than carrying an error. The caller sees a truncated SSE stream.
        //
        // That truncation is what a Pi-driven caller classifies on, and it
        // classifies as retryable without help from this text: pi-ai's adapters
        // throw on a premature end — `openai-completions.js` "Stream ended
        // without finish_reason" (whenever `compat.supportsFinishReason`, its
        // default), `google-generative-ai.js` "Google stream ended without a
        // finish reason", `anthropic-messages.js` "Anthropic stream ended
        // before message_stop" — and those match
        // `RETRYABLE_PROVIDER_ERROR_PATTERN` (`dist/utils/retry.js`:
        // `ended without`, `stream ended before message_stop`). So the wording
        // below is free to change; keep it operator-legible.
        onTeardownError(
          new Error(`LLM upstream stream timed out: no data received for ${idleTimeoutMs}ms`),
        );
        // Release the upstream/tee branch, then close cleanly per the contract
        // above. Swallow a cancel rejection so teardown can't itself escape.
        // This is only HALF the reclamation — `tee()` cancels its source once
        // BOTH branches are cancelled, and the metering tap holds the other
        // one; it carries the same idle bound for exactly that reason.
        void reader.cancel(new Error("llm-proxy: SSE idle timeout")).catch(() => {});
        closeSafely(controller);
        return;
      }
      if (result.done) {
        closeSafely(controller);
        return;
      }
      try {
        controller.enqueue(result.value);
      } catch {
        // Consumer cancelled between read and enqueue — not a teardown.
      }
    },
    cancel(reason) {
      // Client disconnected — release the upstream/tee branch. Swallow a
      // cancel rejection so teardown cleanup can't itself escape.
      void reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * Forward an upstream LLM response to the caller and record usage — the single
 * forwarding terminus, reached through the protocol-adapter core
 * ({@link proxyLlmCall}). Handles the three branches
 * identically (errors verbatim + un-metered; SSE teed + tapped out-of-band;
 * non-streaming JSON buffered + metered), with optional alias-swap and
 * response-cache woven in. Returns the client-facing `Response`.
 *
 * The upstream MUST be the raw fetch Response (its body is consumed here).
 */
export async function forwardMeteredResponse(
  upstream: Response,
  adapter: LlmProxyAdapter,
  ctx: MeteredForwardContext,
  options: MeteredForwardOptions,
): Promise<Response> {
  const { swap, cache } = options;

  const record = options.recordUsage ?? recordProxyUsage;
  const meter = (usage: UpstreamUsage | null): Promise<void> =>
    record({
      principal: ctx.principal,
      runId: ctx.runId,
      chatSessionId: ctx.chatSessionId,
      presetId: ctx.presetId,
      resolved: ctx.resolved,
      usage,
      durationMs: Date.now() - ctx.started,
    });

  // Upstream errors: never meter (no tokens produced). No swap → forwarded
  // verbatim. With a swap the error body is free-form prose that can name the
  // backing anywhere (model id, hostname, provider vocabulary), so it is never
  // forwarded — a synthetic neutral envelope replaces it (whitelist by
  // construction); the upstream detail stays in server logs only.
  if (!upstream.ok) {
    const errorBody = await upstream.text();
    if (swap) {
      return syntheticAliasErrorResponse(
        swap,
        upstream.headers,
        upstream.status,
        "llm-proxy: upstream error on aliased model — synthesized envelope",
        {
          status: upstream.status,
          presetId: ctx.presetId,
          runId: ctx.runId,
          bodySample: errorBody.slice(0, 200),
        },
      );
    }
    return new Response(errorBody, {
      status: upstream.status,
      headers: cloneResponseHeaders(upstream.headers),
    });
  }

  const isSse = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  if (isSse && upstream.body) {
    const [clientStream, tapStream] = upstream.body.tee();
    void tapSseUsage(tapStream, adapter)
      .then(meter)
      .catch((err: unknown) => {
        // The tap is out-of-band of the client stream. Direct DB failures are
        // normally recovered by the durable retry queue; reaching this catch
        // means parsing failed or both persistence channels failed, and must
        // surface loudly rather than become an unhandled rejection.
        logger.error("llm-proxy: SSE usage metering failed", {
          runId: ctx.runId,
          presetId: ctx.presetId,
          error: getErrorMessage(err),
        });
      });
    const headers = buildClientHeaders(upstream.headers, swap);
    // Tell an intermediary not to buffer this stream. `/api/realtime/*` sets
    // this and the chat stream inherits it from the AI SDK's own
    // `UI_MESSAGE_STREAM_HEADERS`; this was the third SSE producer and had
    // neither, because both header paths above it derive from the UPSTREAM
    // reply and no model vendor sends it. `/api/llm-proxy/*` is a documented
    // public endpoint returning `text/event-stream`, so a self-hoster who put
    // nginx in front got the whole completion in one batch at the end — the
    // exact symptom the realtime fix was written to remove, on a surface the
    // self-hosting guide told them was already covered.
    headers.set("X-Accel-Buffering", "no");
    // Guard the raw client branch FIRST (before the alias-swap pipe) so the
    // swapped stream is fed by a source that never errors — see
    // {@link guardSseTeardown} for why guarding after `pipeThrough` would leave
    // its internal pipe promise exposed.
    const guarded = guardSseTeardown(clientStream, (err) => {
      logger.error("llm-proxy: SSE client stream teardown failed", {
        runId: ctx.runId,
        presetId: ctx.presetId,
        error: getErrorMessage(err),
      });
    });
    const clientStream2 = swap ? guarded.pipeThrough(createSseModelSwapStream(swap)) : guarded;
    return new Response(clientStream2, { status: upstream.status, headers });
  }

  // Non-streaming JSON: read once, parse for usage, forward an identical copy.
  const bodyText = await upstream.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // Non-JSON 2xx (unexpected): the upstream accepted and billed the call, so
    // it is METERED as an unparseable-usage row (zero tokens, marked request
    // id) rather than dropped — an invisible paid call is worse than a
    // zero-priced one. With a swap the alias contract can't be upheld on an
    // unparsable body (the echoed real model id can't be rewritten), so
    // synthesize the neutral envelope and degrade the 2xx to a 502: a body the
    // caller can't use as a completion must not masquerade as a success.
    await meter(null);
    if (swap) {
      return syntheticAliasErrorResponse(
        swap,
        upstream.headers,
        502,
        "llm-proxy: non-JSON 2xx on aliased model — synthesized envelope",
        {
          status: upstream.status,
          presetId: ctx.presetId,
          runId: ctx.runId,
          bodySample: bodyText.slice(0, 200),
        },
      );
    }
    return new Response(bodyText, {
      status: upstream.status,
      headers: cloneResponseHeaders(upstream.headers),
    });
  }

  // The upstream body is fully buffered, so awaiting the insert (or durable
  // retry enqueue) removes the observable race. Streaming uses `void`
  // deliberately — its bytes are already on the wire.
  await meter(adapter.parseJsonUsage(parsed));

  const headers = buildClientHeaders(upstream.headers, swap);
  // Rewrite the echoed real id back to the alias BEFORE the body leaves the
  // server — and before caching, so a replay returns the alias too.
  const clientBody = swap ? swapResponseModelJson(bodyText, swap) : bodyText;
  if (cache) {
    void storeResponse({
      cacheKey: cache.cacheKey,
      ttlSeconds: cache.ttlSeconds,
      status: upstream.status,
      headers,
      body: clientBody,
    }).catch((err) => {
      // Best-effort cache write — a failure must never reject unhandled or
      // affect the response already being returned to the client.
      logger.warn("llm-proxy: response cache write failed", {
        error: getErrorMessage(err),
      });
    });
    headers.set("x-llm-proxy-cache-status", "MISS");
  }
  return new Response(clientBody, { status: upstream.status, headers });
}
