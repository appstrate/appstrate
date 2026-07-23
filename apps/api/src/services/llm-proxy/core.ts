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
import { checkEgressUrl, egressGuardedFetch } from "../../lib/egress-host-guard.ts";
import { SsrfBlockedError } from "@appstrate/core/ssrf";
import { getModelProvider } from "../model-providers/registry.ts";
import type { ModelSwap } from "@appstrate/core/sidecar-types";

/** Maximum request body the proxy will accept before refusing up-front. */
const DEFAULT_MAX_REQUEST_BYTES = 10 * 1024 * 1024;

export interface ProxyCallInputs {
  adapter: LlmProxyAdapter;
  principal: LlmProxyPrincipal;
  /** Forwarded to `llm_usage.run_id`. Populated by Phase 4's `X-Run-Id` header. */
  runId: string | null;
  /**
   * Forwarded to `llm_usage.chat_session_id`. Read from the VALIDATED loopback
   * bearer's claims (chat's built-in ai-sdk path), never a spoofable header;
   * null for headless/CLI proxy calls.
   */
  chatSessionId: string | null;
  /** Request URL path *after* the route prefix, e.g. `/v1/chat/completions`. */
  upstreamPath: string;
  incomingHeaders: Headers;
  rawBody: Uint8Array;
  /**
   * Injected for tests; production omits it. The upstream call always goes
   * through `egressGuardedFetch` — when this seam is injected, the guard
   * still runs its per-hop host checks but delegates the connection to the
   * injected fetch (the address pin is skipped, per the `guardedFetch`
   * contract). The production default (no injection) is the pinned path.
   */
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
 * subscription upstream — so subscription providers have no path here.
 * Subscription models are served exclusively by the Pi engine (in-process chat
 * engine + sidecar bearer-swap for runs), where pi-ai emits the provider's own
 * subscription request shape.
 */
export class LlmProxyUnsupportedSubscriptionError extends Error {
  // `providerId` stays a public property for server-side logging, but the
  // message must not name it — the backing provider of an aliased model is
  // never caller-facing (alias masking).
  constructor(public readonly providerId: string) {
    super(
      `This model is backed by an OAuth subscription and cannot be served through ` +
        `this gateway (no fingerprint forging). Subscription models are only usable ` +
        `through the platform's own chat and agent runs. Use an API-key model instead.`,
    );
    this.name = "LlmProxyUnsupportedSubscriptionError";
  }
}

export async function proxyLlmCall(inputs: ProxyCallInputs): Promise<Response> {
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

  // SSRF pre-flight: an openai-compatible provider lets an org configure an
  // arbitrary baseUrl. `checkEgressUrl` gives the richer non-throwing decision
  // (URL parse → invalid-url, scheme floor, allowlist-aware literal + DNS
  // host gate) so a bad baseUrl maps to a clean 400 with the block reason
  // logged server-side. The resolved base URL is the real backing endpoint —
  // server-log-only (logged here); the caller-facing message must not embed
  // it or the block reason. The WIRE call below re-runs the same guard per
  // hop and pins the connection — this check is UX/logging, not the defence.
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
    // Canonical SSRF-guarded transport (same primitive as the credential
    // proxy): per-hop DNS re-validation and — on the production path (no
    // injected fetchImpl) — a connection PINNED to the validated address
    // while preserving `Host` + TLS SNI, closing the check-then-fetch
    // DNS-rebind TOCTOU that a bare `fetch(upstreamUrl)` reopens after the
    // pre-flight above.
    //
    // maxRedirects: 0 — an inference endpoint has no legitimate reason to
    // redirect, and following one would replay the provider API key (in
    // `upstreamHeaders`) against whatever host the redirect names.
    //
    // timeoutMs: 0 — disables the guard's 30 s first-byte default. A
    // non-streaming completion legitimately holds the response headers past
    // 30 s; the previous raw fetch here had no deadline either (behaviour
    // preserved, the caller's disconnect remains the effective bound).
    upstream = await egressGuardedFetch(
      upstreamUrl,
      {
        method: "POST",
        headers: upstreamHeaders,
        body: rewrittenBody,
      },
      {
        maxRedirects: 0,
        timeoutMs: 0,
        logger,
        ...(inputs.fetchImpl ? { fetchImpl: inputs.fetchImpl } : {}),
      },
    );
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      // A hop the pre-flight passed got blocked at wire time (DNS rebind
      // between check and connect, or an upstream redirect — refused
      // outright via maxRedirects: 0). Same caller-facing message as the
      // pre-flight: never leak the host or block reason.
      logger.error("llm-proxy: refused blocked upstream (SSRF)", {
        presetId,
        upstreamUrl,
        reason: err.reason,
        host: err.host,
      });
      throw invalidRequest(
        `Model "${presetId}" resolves to a blocked address — refusing to proxy.`,
      );
    }
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
    {
      principal: inputs.principal,
      runId: inputs.runId,
      chatSessionId: inputs.chatSessionId,
      presetId,
      resolved,
      started,
    },
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
