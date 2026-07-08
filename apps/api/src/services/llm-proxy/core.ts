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
import { lookupResponse } from "./response-cache.ts";
import { parseProxyRequest } from "./helpers.ts";
import { forwardMeteredResponse } from "./metering.ts";
import type { LlmProxyAdapter, LlmProxyPrincipal } from "./types.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { checkEgressUrl } from "../../lib/egress-host-guard.ts";
import { getModelProvider } from "../model-providers/registry.ts";
import type { ModelSwap } from "@appstrate/core/sidecar-types";

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
    aliased = false,
  ) {
    super(
      // For an alias the backing apiShape is masked on the public DTO
      // (`projectAliasedModel` nulls it), so naming `actual` here would leak
      // the backing protocol family to the caller. `actual` stays a property
      // for server-side logging; only non-aliased presets get the detail.
      aliased
        ? `Model "${presetId}" is not served by this endpoint.`
        : `Model "${presetId}" uses "${actual}"; this endpoint serves "${expected}". Use the corresponding /api/llm-proxy/<api>/… route.`,
    );
    this.name = "LlmProxyModelApiMismatchError";
  }
}

/**
 * Thrown when an OAuth-subscription model is requested through this generic
 * gateway. The gateway forges nothing — a raw bearer alone won't satisfy a
 * subscription upstream — so subscription providers have no path here. A
 * subscription is only serviceable through its OWN dedicated official-binary SDK
 * gateway (where the vendor's binary signs its own client fingerprint); a
 * subscription engine with no such gateway has no chat path at all (so no path
 * here — this gateway never forges).
 */
export class LlmProxyUnsupportedSubscriptionError extends Error {
  // `providerId` stays a public property for server-side logging, but the
  // message must not name it — the backing provider of an aliased model is
  // never caller-facing (alias masking).
  constructor(public readonly providerId: string) {
    super(
      `This model is backed by an OAuth subscription and cannot be served through ` +
        `this gateway (no fingerprint forging). Subscription chat is only available when ` +
        `the provider's subscription engine has a dedicated official-binary SDK gateway; ` +
        `this credential's engine has none. Use an API-key model instead.`,
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
  // Subscription chat runs on the in-process Pi engine (module-chat), not here;
  // subscription runs go through the sidecar's oauth gateway. Reject them here.
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

  const upstreamUrl = joinUpstreamUrl(resolved.baseUrl, inputs.upstreamPath);

  // SSRF defence-in-depth: an openai-compatible provider lets an org configure
  // an arbitrary baseUrl. Route it through the canonical egress guard (parse +
  // scheme floor + allowlist-aware literal + DNS-rebind host gate) so this site
  // can't drift from the other platform egress paths. The resolved base URL is
  // the real backing endpoint — server-log-only (logged here); the caller-facing
  // message must not embed it or the block reason.
  const egress = await checkEgressUrl(upstreamUrl);
  if (!egress.ok) {
    logger.error("llm-proxy: refused blocked upstream (SSRF)", {
      presetId,
      upstreamUrl,
      reason: egress.reason,
      detail: egress.detail,
    });
    throw invalidRequest(`Model "${presetId}" resolves to a blocked address — refusing to proxy.`);
  }

  const upstreamHeaders = inputs.adapter.buildUpstreamHeaders(
    inputs.incomingHeaders,
    resolved.apiKey,
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

  // Forward + meter, weaving in the alias-swap (every branch) and the
  // response-cache write (non-streaming 2xx). Shared with the Claude Code
  // subscription gateway, which forwards verbatim (no swap, no cache).
  return forwardMeteredResponse(
    upstream,
    inputs.adapter,
    { principal: inputs.principal, runId: inputs.runId, presetId, resolved, started },
    {
      swap,
      cache: cacheKeyForWrite
        ? { cacheKey: cacheKeyForWrite, ttlSeconds: cacheConfig.ttlSeconds }
        : null,
      logLabel: "llm-proxy",
    },
  );
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
    throw new LlmProxyModelApiMismatchError(presetId, expectedApi, loaded.apiShape, loaded.aliased);
  }
  return loaded;
}

function joinUpstreamUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const normalisedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${normalisedPath}`;
}
