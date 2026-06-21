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

import { loadModel, type ResolvedModel } from "../org-models.ts";
import { logger } from "../../lib/logger.ts";
import { invalidRequest } from "../../lib/errors.ts";
import { getResponseCacheConfig } from "../../lib/llm-proxy-cache-config.ts";
import { lookupResponse, storeResponse } from "./response-cache.ts";
import { parseProxyRequest } from "./helpers.ts";
import { cloneResponseHeaders, recordProxyUsage, tapSseUsage } from "./metering.ts";
import type { LlmProxyAdapter, LlmProxyPrincipal } from "./types.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { getModelProvider } from "../model-providers/registry.ts";
import { getModuleLlmBodyTransformer } from "../../lib/modules/module-loader.ts";
import type { ModelSwap } from "@appstrate/core/sidecar-types";
import {
  swapResponseModelJson,
  createSseModelSwapStream,
  scrubModelText,
} from "@appstrate/core/model-swap";

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

/**
 * Thrown when an OAuth-subscription model is requested through this generic
 * gateway. The gateway forges nothing — a raw bearer alone won't satisfy a
 * subscription upstream — so subscription providers have no path here. The only
 * supported subscription is `claude-code`, served by its own dedicated SDK
 * gateway (`claude-code-sdk-gateway.ts`), where the official Claude Agent SDK
 * signs its own client fingerprint. Any other subscription has no
 * ToS-compliant chat path.
 */
export class LlmProxyUnsupportedSubscriptionError extends Error {
  constructor(public readonly providerId: string) {
    super(
      `Provider "${providerId}" is an OAuth subscription and cannot be served through ` +
        `this gateway (no fingerprint forging). Only "claude-code" supports subscription ` +
        `chat, via its dedicated SDK gateway. Use an API-key model instead.`,
    );
    this.name = "LlmProxyUnsupportedSubscriptionError";
  }
}

export async function proxyLlmCall(inputs: ProxyCallInputs): Promise<Response> {
  const fetchImpl = inputs.fetchImpl ?? fetch;
  const maxBytes = inputs.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  if (inputs.rawBody.byteLength > maxBytes) {
    throw invalidRequest(`Request body exceeds LLM_PROXY_LIMITS.max_request_bytes (${maxBytes})`);
  }

  const request = parseProxyRequest(inputs.rawBody);
  const presetId = request.presetId;
  const resolved = await resolvePresetForOrg(
    presetId,
    inputs.principal.orgId,
    inputs.adapter.apiShape,
  );

  // No fingerprint forging: an OAuth-subscription provider has no path through
  // this generic gateway (a bare bearer won't satisfy a subscription upstream).
  // claude-code is served by its own SDK gateway; reject everything else.
  if (getModelProvider(resolved.providerId)?.authMode === "oauth2") {
    throw new LlmProxyUnsupportedSubscriptionError(resolved.providerId);
  }

  const rewrittenBody = request.rewriteModel(resolved.modelId);

  // Model-alias swap (issue #727). When the resolved preset is an alias, the
  // upstream echoes the REAL id in its response `model` field (and may name it
  // in error prose). Rewrite it back to the alias on every response branch —
  // and on the cached body — so a caller of `/api/llm-proxy/*` (incl. a
  // dashboard `jwt_user`) never sees the backing. The request `model` was
  // already rewritten alias→real by `request.rewriteModel` above. This mirrors
  // the in-container sidecar path; both share `@appstrate/core/model-swap`.
  const swap: ModelSwap | null = resolved.aliased
    ? { alias: presetId, real: resolved.modelId }
    : null;

  // Response-cache lookup. The cache is keyed on `(orgId, presetId,
  // apiShape, modelId, requestBody)` so cross-org / cross-preset
  // requests never collide. Skips streaming (`stream: true`) requests —
  // SSE replays are far less useful and complicate the contract.
  // Misses still cost us the key hash, but `lookupResponse` returns
  // it so the writer side doesn't have to recompute.
  const cacheConfig = getResponseCacheConfig();
  let cacheKeyForWrite: string | null = null;
  if (cacheConfig.enabled && !request.stream) {
    const probe = await lookupResponse({
      orgId: inputs.principal.orgId,
      presetId,
      apiShape: resolved.apiShape,
      upstreamModelId: resolved.modelId,
      requestBody: rewrittenBody,
    });
    if (probe.hit) {
      logger.info("llm-proxy: cache hit", {
        presetId,
        cacheKey: probe.cacheKey,
        orgId: inputs.principal.orgId,
      });
      return probe.response;
    }
    cacheKeyForWrite = probe.cacheKey;
  }

  // PII anonymization seam (module-anonymizer). Absent module → null → bodies
  // forwarded untouched (zero footprint). ONE transformer per call so the mask
  // table built for the request is the one that restores its own response.
  // Built after the cache lookup: a cache hit already returned a restored body.
  const anonymizer =
    getModuleLlmBodyTransformer()?.create({
      runId: inputs.runId,
      orgId: inputs.principal.orgId,
    }) ?? null;
  const restorePii = (text: string): Promise<string> =>
    anonymizer ? anonymizer.restoreResponse(text) : Promise.resolve(text);
  const outboundBody = anonymizer ? await anonymizer.maskRequest(rewrittenBody) : rewrittenBody;

  const upstreamUrl = joinUpstreamUrl(resolved.baseUrl, inputs.upstreamPath);
  const upstreamHeaders = inputs.adapter.buildUpstreamHeaders(
    inputs.incomingHeaders,
    resolved.apiKey,
    resolved.accountId,
  );

  const started = Date.now();
  let upstream: Response;
  try {
    upstream = await fetchImpl(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: outboundBody,
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
    // Error bodies are free-form prose that may name the real id ("model
    // deepseek-chat does not exist") — blind-scrub it back to the alias, then
    // restore any PII tokens the upstream echoed into its message.
    const clientBody = await restorePii(swap ? scrubModelText(errorBody, swap) : errorBody);
    return new Response(clientBody, { status: upstream.status, headers });
  }

  if (isSse && upstream.body) {
    const [clientStream, tapStream] = upstream.body.tee();
    void tapSseUsage(tapStream, inputs.adapter)
      .then((usage) =>
        recordProxyUsage({
          principal: inputs.principal,
          runId: inputs.runId,
          presetId,
          resolved,
          usage,
          durationMs: Date.now() - started,
        }),
      )
      .catch((err: unknown) => {
        // Metering tap is best-effort and out-of-band of the client stream;
        // a parse/insert failure must surface in logs, not vanish into an
        // unhandled rejection (silent usage under-counting otherwise).
        logger.error("llm-proxy: SSE usage metering failed", {
          runId: inputs.runId,
          presetId,
          error: getErrorMessage(err),
        });
      });
    const headers = cloneResponseHeaders(upstream.headers);
    // Rewrite the echoed real id back to the alias in every SSE frame, then
    // restore PII tokens per frame. The tap above reads the untouched
    // `tapStream`, so accounting still sees the real id and the masked tokens;
    // only the client-facing copy is swapped + restored.
    let clientStream2 = swap
      ? clientStream.pipeThrough(createSseModelSwapStream(swap))
      : clientStream;
    if (anonymizer) clientStream2 = clientStream2.pipeThrough(anonymizer.restoreResponseStream());
    return new Response(clientStream2, {
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
    // non-SSE body — forward without metering. Scrub any real id from the
    // free-form body for aliases, then restore PII tokens.
    const headers = cloneResponseHeaders(upstream.headers);
    const clientBody = await restorePii(swap ? scrubModelText(bodyText, swap) : bodyText);
    return new Response(clientBody, { status: upstream.status, headers });
  }

  const usage = inputs.adapter.parseJsonUsage(parsed);
  if (usage) {
    // Non-streaming path: the upstream body is already fully buffered,
    // so awaiting the metering insert costs ~1ms and removes the
    // observable race. `recordProxyUsage` swallows its own DB errors (a
    // failed insert never breaks the call), so awaiting is safe.
    // Streaming uses `void tapSseUsage(...)` deliberately — the
    // response is already on the wire before the SSE tap drains.
    await recordProxyUsage({
      principal: inputs.principal,
      runId: inputs.runId,
      presetId,
      resolved,
      usage,
      durationMs: Date.now() - started,
    });
  }

  const headers = cloneResponseHeaders(upstream.headers);
  // Rewrite the echoed real id back to the alias AND restore PII tokens before
  // the body leaves the server — and BEFORE caching, so a replay returns the
  // alias + the restored (real) values too.
  const clientBody = await restorePii(swap ? swapResponseModelJson(bodyText, swap) : bodyText);
  // Persist 2xx replies for future lookups. Tag the MISS so the caller
  // sees a consistent `x-llm-proxy-cache-status` contract whether the
  // cache is enabled or off.
  if (cacheKeyForWrite) {
    void storeResponse({
      cacheKey: cacheKeyForWrite,
      ttlSeconds: cacheConfig.ttlSeconds,
      status: upstream.status,
      headers,
      body: clientBody,
    });
    headers.set("x-llm-proxy-cache-status", "MISS");
  }
  return new Response(clientBody, { status: upstream.status, headers });
}

async function resolvePresetForOrg(
  presetId: string,
  orgId: string,
  expectedApi: string,
): Promise<ResolvedModel> {
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
  return loaded;
}

function joinUpstreamUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const normalisedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${normalisedPath}`;
}
