// SPDX-License-Identifier: Apache-2.0

/**
 * Protocol-agnostic core of `/api/llm-proxy/*`.
 *
 * Pipeline:
 *   1. Parse the JSON body, extract `model` (the preset id), reject
 *      anything that doesn't look like a chat/messages payload.
 *   2. Resolve the preset against `org_models` + `model_provider_credentials`
 *      via `loadModel()`. Fail closed on protocol mismatch.
 *   3. Substitute `model` → real upstream id, forward to the adapter's
 *      upstream base URL with adapter-specific headers.
 *   4. Stream the response through to the caller verbatim; tap the
 *      bytes in parallel (via `tee()`) to parse usage for accounting.
 *   5. Insert one `llm_usage` row (source="proxy") with cost = Σ(tokens × cost/1e6).
 *
 * Zero retries, zero body rewrites beyond `model`. Anthropic prompt
 * caching blocks, extended-thinking, tool use — all pass untouched.
 */

import { db } from "@appstrate/db/client";
import { llmUsage } from "@appstrate/db/schema";
import { loadModel } from "../org-models.ts";
import { logger } from "../../lib/logger.ts";
import { invalidRequest } from "../../lib/errors.ts";
import type {
  LlmProxyAdapter,
  LlmProxyPrincipal,
  ResolvedProxyModel,
  UpstreamUsage,
} from "./types.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import type { ModelCost } from "@appstrate/shared-types";

/** Maximum request body the proxy will accept before refusing up-front. */
const DEFAULT_MAX_REQUEST_BYTES = 10 * 1024 * 1024;

export interface ProxyCallInputs {
  adapter: LlmProxyAdapter;
  principal: LlmProxyPrincipal;
  /** Forwarded to `llm_usage.run_id`. Populated by Phase 4's `X-Run-Id` header. */
  runId: string | null;
  /** Request URL path *after* the route prefix, e.g. `/v1/chat/completions`. */
  upstreamPath: string;
  incomingHeaders: Headers;
  rawBody: Uint8Array;
  /** Injected for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Override the request-body cap. Defaults to 10 MiB. */
  maxRequestBytes?: number;
}

export class LlmProxyUnsupportedModelError extends Error {
  constructor(presetId: string) {
    super(`Model preset "${presetId}" is not enabled for this organization.`);
    this.name = "LlmProxyUnsupportedModelError";
  }
}

export class LlmProxyModelApiMismatchError extends Error {
  constructor(
    public readonly presetId: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `Model "${presetId}" uses "${actual}"; this endpoint serves "${expected}". Use the corresponding /api/llm-proxy/<api>/… route.`,
    );
    this.name = "LlmProxyModelApiMismatchError";
  }
}

export async function proxyLlmCall(inputs: ProxyCallInputs): Promise<Response> {
  const fetchImpl = inputs.fetchImpl ?? fetch;
  const maxBytes = inputs.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  if (inputs.rawBody.byteLength > maxBytes) {
    throw invalidRequest(`Request body exceeds LLM_PROXY_LIMITS.max_request_bytes (${maxBytes})`);
  }

  const presetId = extractPresetId(inputs.rawBody);
  const resolved = await resolvePresetForOrg(presetId, inputs.principal.orgId, inputs.adapter.api);

  const rewrittenBody = inputs.adapter.substituteModel(inputs.rawBody, resolved.realModelId);
  const upstreamUrl = joinUpstreamUrl(resolved.baseUrl, inputs.upstreamPath);
  const upstreamHeaders = inputs.adapter.buildUpstreamHeaders(
    inputs.incomingHeaders,
    resolved.upstreamApiKey,
  );

  const started = Date.now();
  let upstream: Response;
  try {
    upstream = await fetchImpl(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: rewrittenBody,
    });
  } catch (err) {
    logger.error("llm-proxy: upstream fetch failed", {
      presetId,
      upstreamUrl,
      error: getErrorMessage(err),
    });
    throw err;
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  const isSse = contentType.includes("text/event-stream");

  // Upstream errors: surface verbatim but DON'T meter them as usage —
  // the call never produced tokens. We read + rebuild the Response so
  // `cloneResponseHeaders` can strip `content-length` / `content-encoding`
  // — Bun already decompressed the body here, so forwarding the
  // upstream's encoding header would trip the caller's decoder.
  if (!upstream.ok) {
    const errorBody = await upstream.text();
    const headers = cloneResponseHeaders(upstream.headers);
    return new Response(errorBody, { status: upstream.status, headers });
  }

  if (isSse && upstream.body) {
    const [clientStream, tapStream] = upstream.body.tee();
    void tapSseStream(tapStream, inputs.adapter).then((usage) =>
      recordUsage({
        principal: inputs.principal,
        runId: inputs.runId,
        resolved,
        usage,
        durationMs: Date.now() - started,
      }),
    );
    const headers = cloneResponseHeaders(upstream.headers);
    return new Response(clientStream, {
      status: upstream.status,
      headers,
    });
  }

  // Non-streaming JSON. Read once, parse for usage, forward an identical
  // copy to the caller (we can't reuse the upstream Response — its body
  // has been consumed).
  const bodyText = await upstream.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // Upstream advertised a non-JSON content-type but still returned a
    // non-SSE body — forward without metering.
    const headers = cloneResponseHeaders(upstream.headers);
    return new Response(bodyText, { status: upstream.status, headers });
  }

  const usage = inputs.adapter.parseJsonUsage(parsed);
  if (usage) {
    // Non-streaming path: the upstream body is already fully buffered,
    // so awaiting the metering insert costs ~1ms and removes the
    // observable race. `recordUsage` swallows its own DB errors (a
    // failed insert never breaks the call), so awaiting is safe.
    // Streaming uses `void tapSseStream(...)` deliberately — the
    // response is already on the wire before the SSE tap drains.
    await recordUsage({
      principal: inputs.principal,
      runId: inputs.runId,
      resolved,
      usage,
      durationMs: Date.now() - started,
    });
  }

  const headers = cloneResponseHeaders(upstream.headers);
  return new Response(bodyText, { status: upstream.status, headers });
}

function extractPresetId(rawBody: Uint8Array): string {
  const text = new TextDecoder().decode(rawBody);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidRequest("Request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidRequest("Request body must be a JSON object");
  }
  const model = (parsed as Record<string, unknown>)["model"];
  if (typeof model !== "string" || model.length === 0) {
    throw invalidRequest("Request body must include a non-empty `model` field");
  }
  return model;
}

async function resolvePresetForOrg(
  presetId: string,
  orgId: string,
  expectedApi: string,
): Promise<ResolvedProxyModel> {
  // `loadModel` hits `org_models` by UUID — passing a string that isn't a
  // UUID raises a DB-level error rather than returning null. Catch and
  // normalise into "preset not found" so the caller sees a clean 400
  // instead of a 500.
  let loaded: Awaited<ReturnType<typeof loadModel>>;
  try {
    loaded = await loadModel(orgId, presetId);
  } catch {
    throw new LlmProxyUnsupportedModelError(presetId);
  }
  if (!loaded) {
    throw new LlmProxyUnsupportedModelError(presetId);
  }
  if (loaded.apiShape !== expectedApi) {
    throw new LlmProxyModelApiMismatchError(presetId, expectedApi, loaded.apiShape);
  }
  return {
    presetId,
    api: loaded.apiShape,
    baseUrl: loaded.baseUrl,
    realModelId: loaded.modelId,
    upstreamApiKey: loaded.apiKey,
    cost: loaded.cost ?? null,
  };
}

function joinUpstreamUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const normalisedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${normalisedPath}`;
}

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

// Bun's fetch auto-decompresses upstream responses, so `upstream.body`
// holds plaintext even when the upstream advertised `content-encoding:
// gzip`. Forwarding the original encoding header would tell the caller
// to decompress bytes that aren't compressed → ZlibError. We also drop
// `content-length` because it described the compressed payload; the
// rewrapped Response recomputes it from the uncompressed body.
const STRIPPED_CONTENT_HEADERS = new Set(["content-encoding", "content-length"]);

function cloneResponseHeaders(src: Headers): Headers {
  const out = new Headers();
  src.forEach((v, k) => {
    const lower = k.toLowerCase();
    if (HOP_BY_HOP.has(lower)) return;
    if (STRIPPED_CONTENT_HEADERS.has(lower)) return;
    out.set(k, v);
  });
  return out;
}

async function tapSseStream(
  stream: ReadableStream<Uint8Array>,
  adapter: LlmProxyAdapter,
): Promise<UpstreamUsage | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) buffer += decoder.decode(value, { stream: true });
      // Split on SSE frame delimiter (blank line). Keep the tail in the
      // buffer until the next chunk — a frame may straddle chunks.
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        frames.push(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
    }
    if (buffer.trim().length > 0) frames.push(buffer);
  } catch (err) {
    logger.warn("llm-proxy: stream tap read failed — usage not recorded", {
      error: getErrorMessage(err),
    });
    return null;
  }
  return adapter.parseSseUsage(frames);
}

interface RecordUsageInputs {
  principal: LlmProxyPrincipal;
  runId: string | null;
  resolved: ResolvedProxyModel;
  usage: UpstreamUsage | null;
  durationMs: number;
}

async function recordUsage(inputs: RecordUsageInputs): Promise<void> {
  if (!inputs.usage) return;
  try {
    await db.insert(llmUsage).values({
      source: "proxy",
      orgId: inputs.principal.orgId,
      apiKeyId: inputs.principal.kind === "api_key" ? inputs.principal.apiKeyId : null,
      userId: inputs.principal.kind === "jwt_user" ? inputs.principal.userId : null,
      runId: inputs.runId,
      model: inputs.resolved.presetId,
      realModel: inputs.resolved.realModelId,
      api: inputs.resolved.api,
      inputTokens: inputs.usage.inputTokens,
      outputTokens: inputs.usage.outputTokens,
      cacheReadTokens: inputs.usage.cacheReadTokens ?? null,
      cacheWriteTokens: inputs.usage.cacheWriteTokens ?? null,
      costUsd: computeCostUsd(inputs.usage, inputs.resolved.cost),
      durationMs: inputs.durationMs,
      // Fresh UUID per upstream call — satisfies the partial-unique index
      // on (source='proxy', request_id). CLI-level retries land as new
      // rows (same behaviour as pre-ledger; idempotency belongs to the
      // Idempotency-Key middleware, not the ledger).
      requestId: crypto.randomUUID(),
    });
  } catch (err) {
    // Metering failures MUST NOT break a successful LLM call — the
    // caller already consumed the response bytes. Log and move on;
    // ops can reconcile from upstream provider invoices.
    logger.error("llm-proxy: failed to record usage", {
      orgId: inputs.principal.orgId,
      presetId: inputs.resolved.presetId,
      error: getErrorMessage(err),
    });
  }
}

function computeCostUsd(usage: UpstreamUsage, cost: ModelCost | null): number {
  if (!cost) return 0;
  const perMillion = 1_000_000;
  const inputCost = (usage.inputTokens * cost.input) / perMillion;
  const outputCost = (usage.outputTokens * cost.output) / perMillion;
  const cacheReadCost = ((usage.cacheReadTokens ?? 0) * (cost.cacheRead ?? 0)) / perMillion;
  const cacheWriteCost = ((usage.cacheWriteTokens ?? 0) * (cost.cacheWrite ?? 0)) / perMillion;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}
