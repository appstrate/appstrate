// SPDX-License-Identifier: Apache-2.0

/**
 * Shared response-forwarding + usage-metering for the `/api/llm-proxy/*`
 * surfaces.
 *
 * Both the protocol-adapter core ({@link proxyLlmCall}) and the Claude Code
 * subscription SDK gateway forward an upstream LLM response to the caller and
 * record one `llm_usage` row (source="proxy"). The mechanics are identical:
 *
 *   - strip `content-encoding`/`content-length` from the forwarded headers
 *     (Bun's `fetch` already decompressed the body, so echoing the upstream
 *     encoding would make the caller re-decode plaintext → ZlibError);
 *   - tap the teed SSE stream to extract usage WITHOUT buffering the whole
 *     response;
 *   - insert a usage row whose cost is Σ(tokens × cost/1e6), swallowing DB
 *     errors so a metering failure never breaks a successful LLM call.
 *
 * Keeping them here means the gateway and the core meter byte-for-byte the
 * same way — one place to change the ledger shape.
 */

import { db } from "@appstrate/db/client";
import { llmUsage } from "@appstrate/db/schema";
import { logger } from "../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import type { ModelCost } from "@appstrate/core/module";
import type { ModelSwap } from "@appstrate/core/sidecar-types";
import {
  swapResponseModelJson,
  createSseModelSwapStream,
  scrubModelText,
} from "@appstrate/core/model-swap";
import type { ResolvedModel } from "../org-models.ts";
import { storeResponse } from "./response-cache.ts";
import type { LlmProxyAdapter, LlmProxyPrincipal, UpstreamUsage } from "./types.ts";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// Bun's fetch auto-decompresses upstream responses, so the body holds
// plaintext even when the upstream advertised `content-encoding: gzip`.
// Forwarding the original encoding header would tell the caller to decompress
// bytes that aren't compressed → ZlibError. We also drop `content-length`
// because it described the compressed payload; the rewrapped Response
// recomputes it from the uncompressed body.
const STRIPPED_CONTENT_HEADERS = new Set(["content-encoding", "content-length"]);

/** Clone upstream response headers, dropping hop-by-hop + stale content encoding/length. */
export function cloneResponseHeaders(src: Headers): Headers {
  const out = new Headers();
  src.forEach((v, k) => {
    const lower = k.toLowerCase();
    if (HOP_BY_HOP.has(lower)) return;
    if (STRIPPED_CONTENT_HEADERS.has(lower)) return;
    out.set(k, v);
  });
  return out;
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
 * Tap a teed SSE stream and extract usage WITHOUT retaining the full response
 * (accumulating every frame would be O(response) memory per in-flight
 * stream). Frames are parsed as delimited; only frames that individually
 * yield usage (probed via `adapter.parseSseUsage([frame])`) are retained, in
 * arrival order, and the adapter extracts the final result from that subset —
 * behaviour-identical to scanning every frame for either shipped adapter.
 */
export async function tapSseUsage(
  stream: ReadableStream<Uint8Array>,
  adapter: LlmProxyAdapter,
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
      const { value, done } = await reader.read();
      if (done) break;
      if (value) buffer += decoder.decode(value, { stream: true });
      // Split on SSE frame delimiter (blank line). Keep the tail in the
      // buffer until the next chunk — a frame may straddle chunks.
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        considerFrame(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
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
  /** The Appstrate preset id (org model row id) — stored as `llm_usage.model`. */
  presetId: string;
  resolved: ResolvedModel;
  usage: UpstreamUsage | null;
  durationMs: number;
}

/**
 * Insert one `llm_usage` row (source="proxy"). Metering failures MUST NOT
 * break a successful LLM call — the caller already consumed the response
 * bytes — so DB errors are logged and swallowed (ops reconcile from upstream
 * invoices).
 */
export async function recordProxyUsage(inputs: RecordUsageInputs): Promise<void> {
  if (!inputs.usage) return;
  try {
    await db.insert(llmUsage).values({
      source: "proxy",
      orgId: inputs.principal.orgId,
      apiKeyId: inputs.principal.kind === "api_key" ? inputs.principal.apiKeyId : null,
      userId: inputs.principal.kind === "jwt_user" ? inputs.principal.userId : null,
      runId: inputs.runId,
      model: inputs.presetId,
      realModel: inputs.resolved.modelId,
      api: inputs.resolved.apiShape,
      inputTokens: inputs.usage.inputTokens,
      outputTokens: inputs.usage.outputTokens,
      cacheReadTokens: inputs.usage.cacheReadTokens ?? null,
      cacheWriteTokens: inputs.usage.cacheWriteTokens ?? null,
      costUsd: computeCostUsd(inputs.usage, inputs.resolved.cost ?? null),
      durationMs: inputs.durationMs,
      // Fresh UUID per upstream call — satisfies the partial-unique index on
      // (source='proxy', request_id). CLI-level retries land as new rows.
      requestId: crypto.randomUUID(),
    });
  } catch (err) {
    logger.error("llm-proxy: failed to record usage", {
      orgId: inputs.principal.orgId,
      presetId: inputs.presetId,
      error: getErrorMessage(err),
    });
  }
}

export function computeCostUsd(usage: UpstreamUsage, cost: ModelCost | null): number {
  if (!cost) return 0;
  const perMillion = 1_000_000;
  const inputCost = (usage.inputTokens * cost.input) / perMillion;
  const outputCost = (usage.outputTokens * cost.output) / perMillion;
  const cacheReadCost = ((usage.cacheReadTokens ?? 0) * (cost.cacheRead ?? 0)) / perMillion;
  const cacheWriteCost = ((usage.cacheWriteTokens ?? 0) * (cost.cacheWrite ?? 0)) / perMillion;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

/** Per-call metering context for {@link forwardMeteredResponse}. */
export interface MeteredForwardContext {
  principal: LlmProxyPrincipal;
  runId: string | null;
  /** The Appstrate preset id (stored as `llm_usage.model`). */
  presetId: string;
  resolved: ResolvedModel;
  /** `Date.now()` captured just before the upstream fetch (for `durationMs`). */
  started: number;
}

/** Optional behaviours that differ between the proxy surfaces. */
export interface MeteredForwardOptions {
  /**
   * Model-alias swap (issue #727). When set, the real upstream id echoed by the
   * upstream is rewritten back to the alias on EVERY response branch (error
   * prose, SSE frames, JSON body) so the caller never sees the backing model.
   * The usage tap reads the untouched stream, so accounting still sees the real
   * id. `null` (the subscription gateways) forwards verbatim.
   */
  swap?: ModelSwap | null;
  /**
   * Response-cache write for a non-streaming 2xx reply. When set, the forwarded
   * (already alias-swapped) body is persisted and the `x-llm-proxy-cache-status:
   * MISS` header is stamped. Omitted (subscription gateways) → no caching.
   */
  cache?: { cacheKey: string; ttlSeconds: number } | null;
  /** Log-line prefix for the out-of-band SSE-metering-failure error. */
  logLabel: string;
  /** Side-effect hook on an upstream error (e.g. a `logger.warn`). */
  onUpstreamError?: (status: number) => void;
}

/**
 * Forward an upstream LLM response to the caller and record usage — the single
 * forwarding terminus shared by the protocol-adapter core ({@link proxyLlmCall})
 * and the Claude Code subscription SDK gateway. Handles the three branches
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
  const { swap, cache, logLabel } = options;

  const meter = (usage: UpstreamUsage | null): Promise<void> =>
    recordProxyUsage({
      principal: ctx.principal,
      runId: ctx.runId,
      presetId: ctx.presetId,
      resolved: ctx.resolved,
      usage,
      durationMs: Date.now() - ctx.started,
    });

  // Upstream errors: surface verbatim, never meter (no tokens produced). Error
  // bodies are free-form prose that may name the real id — blind-scrub for aliases.
  if (!upstream.ok) {
    options.onUpstreamError?.(upstream.status);
    const errorBody = await upstream.text();
    const headers = cloneResponseHeaders(upstream.headers);
    const clientBody = swap ? scrubModelText(errorBody, swap) : errorBody;
    return new Response(clientBody, { status: upstream.status, headers });
  }

  const isSse = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  if (isSse && upstream.body) {
    const [clientStream, tapStream] = upstream.body.tee();
    void tapSseUsage(tapStream, adapter)
      .then(meter)
      .catch((err: unknown) => {
        // Metering tap is best-effort and out-of-band of the client stream; a
        // parse/insert failure must surface in logs, not vanish into an
        // unhandled rejection (silent usage under-counting otherwise).
        logger.error(`${logLabel}: SSE usage metering failed`, {
          runId: ctx.runId,
          presetId: ctx.presetId,
          error: getErrorMessage(err),
        });
      });
    const headers = cloneResponseHeaders(upstream.headers);
    const clientStream2 = swap
      ? clientStream.pipeThrough(createSseModelSwapStream(swap))
      : clientStream;
    return new Response(clientStream2, { status: upstream.status, headers });
  }

  // Non-streaming JSON: read once, parse for usage, forward an identical copy.
  const bodyText = await upstream.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // Non-JSON 2xx (unexpected) — forward without metering, scrubbing aliases.
    const headers = cloneResponseHeaders(upstream.headers);
    const clientBody = swap ? scrubModelText(bodyText, swap) : bodyText;
    return new Response(clientBody, { status: upstream.status, headers });
  }

  // The upstream body is fully buffered, so awaiting the insert costs ~1ms and
  // removes the observable race (recordProxyUsage swallows its own DB errors, and
  // no-ops on null usage). Streaming uses `void` deliberately — already on wire.
  await meter(adapter.parseJsonUsage(parsed));

  const headers = cloneResponseHeaders(upstream.headers);
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
    });
    headers.set("x-llm-proxy-cache-status", "MISS");
  }
  return new Response(clientBody, { status: upstream.status, headers });
}
