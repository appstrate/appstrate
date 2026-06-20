// SPDX-License-Identifier: Apache-2.0

/**
 * Claude Code subscription **SDK gateway** —
 * `POST /api/llm-proxy/claude-code-sdk/:presetId/*`.
 *
 * This is the credential-injection gateway the chat module points the
 * official Claude Agent SDK at (`ANTHROPIC_BASE_URL`). It differs
 * fundamentally from the protocol-adapter proxy (`core.ts`):
 *
 *   - **No forging.** The Agent SDK drives the official `claude` binary,
 *     which signs the request with the legitimate Claude Code client
 *     identity itself. This gateway forges nothing — no "You are Claude Code"
 *     prelude, no fingerprint headers. It is the SANCTIONED path — Anthropic's
 *     Help Center allows third-party apps on the Agent SDK with a Claude
 *     subscription. We only swap the bearer for the real subscription token +
 *     add the OAuth beta. (This is the chat-side twin of the runner's sidecar
 *     `oauth` mode.)
 *   - **No body rewrite.** The SDK sends the real upstream model id and its
 *     own system prompt; we forward the body verbatim. The preset id comes
 *     from the URL (it carries the credential + cost), not `body.model`.
 *   - **Credential isolation.** The spawned `claude` binary only ever holds a
 *     placeholder bearer (a turn-scoped chat-loopback token); the real
 *     subscription token is resolved here, server-side, and never enters the
 *     binary's environment.
 *
 * FIRST-PARTY ONLY — same trust boundary as the in-container sidecar: a
 * personal subscription is never spendable through an API key or external token.
 */

import type { Context } from "hono";
import { loadModel, modelNeedsReconnection } from "../org-models.ts";
import { resolveOAuthTokenForSidecar } from "../model-providers/token-resolver.ts";
import { anthropicMessagesAdapter } from "./anthropic.ts";
import { cloneResponseHeaders, recordProxyUsage, tapSseUsage } from "./metering.ts";
import type { LlmProxyPrincipal } from "./types.ts";
import { ApiError, invalidRequest } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { isBlockedUrl } from "@appstrate/core/ssrf";
import type { AppEnv } from "../../types/index.ts";

/** Provider id of the Claude Pro/Max/Team subscription credential. */
export const CLAUDE_CODE_PROVIDER_ID = "claude-code";

/** The beta token that authorizes an OAuth subscription token on /v1/messages. */
const OAUTH_BETA = "oauth-2025-04-20";

/** URL prefix this gateway is mounted under (within the llm-proxy router). */
const ROUTE_PREFIX = "/api/llm-proxy/claude-code-sdk";

/**
 * Derive the upstream subpath (`/v1/messages`, `/v1/messages/count_tokens`, …)
 * from the full request path. The Agent SDK appends Anthropic's own path
 * convention to `ANTHROPIC_BASE_URL` (which we set to
 * `…/claude-code-sdk/:presetId`), so whatever follows the preset segment is
 * forwarded to the upstream verbatim. Pure for unit testing.
 */
export function deriveUpstreamSubpath(fullPath: string, presetId: string): string {
  const base = `${ROUTE_PREFIX}/${presetId}`;
  const idx = fullPath.indexOf(base);
  if (idx === -1) return "/v1/messages";
  const rest = fullPath.slice(idx + base.length);
  return rest.length > 0 ? rest : "/v1/messages";
}

/**
 * Build the upstream headers for an Anthropic subscription call: keep the
 * caller's protocol headers (betas, version), swap in the real Bearer token,
 * add the OAuth beta, and drop the bits that must not leak to the upstream
 * (the placeholder loopback bearer is overwritten; `accept-encoding`/`host`
 * are stripped so Bun's auto-decompression stays consistent). Pure for unit
 * testing.
 */
export function buildSubscriptionHeaders(incoming: Headers, accessToken: string): Headers {
  const headers = new Headers(incoming);
  headers.set("authorization", `Bearer ${accessToken}`);
  headers.delete("x-api-key");
  headers.delete("host");
  headers.delete("content-length");
  // Ask the upstream for identity encoding — Bun's fetch auto-decompresses,
  // and forwarding a gzip body the client won't re-decompress trips ZlibError.
  headers.delete("accept-encoding");

  const betas = new Set(
    (headers.get("anthropic-beta")?.split(",") ?? []).map((s) => s.trim()).filter(Boolean),
  );
  betas.add(OAUTH_BETA);
  headers.set("anthropic-beta", [...betas].join(","));
  if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  return headers;
}

/**
 * Anthropic-native `authentication_error` envelope (HTTP 401) the official
 * `claude` binary understands, so the chat surfaces an actionable "reconnect
 * your subscription" message instead of an opaque transport error or a
 * misleading "model not enabled". Returned for both reconnection paths below.
 */
export function anthropicAuthErrorResponse(): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "authentication_error",
        message: "Reconnectez votre abonnement Claude — la connexion a expiré ou été révoquée.",
      },
    }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

/**
 * Translate a token-resolution failure into {@link anthropicAuthErrorResponse}
 * when it is a `gone()` (HTTP 410) — i.e. a refresh-time revocation discovered
 * by `resolveOAuthTokenForSidecar` (the credential wasn't pre-flagged, the
 * refresh hit `invalid_grant`). Returns `null` for any other error so the
 * caller rethrows — unexpected failures must not masquerade as an auth problem.
 * Pure for unit testing. (The pre-flagged `needsReconnection` case is caught
 * earlier, at the `loadModel` layer, via `modelNeedsReconnection`.)
 */
export function subscriptionAuthErrorResponse(err: unknown): Response | null {
  if (!(err instanceof ApiError) || err.status !== 410) return null;
  return anthropicAuthErrorResponse();
}

/**
 * Handle one upstream call from the Claude Agent SDK. The route layer has
 * already enforced bearer-only + first-party + rate limit + `llm-proxy:call`.
 */
export async function handleClaudeCodeSdkGateway(
  c: Context<AppEnv>,
  maxRequestBytes: number,
): Promise<Response> {
  const orgId = c.get("orgId");
  const userId = c.get("user").id;
  const apiKeyId = c.get("apiKeyId");
  const presetId = c.req.param("presetId");
  if (!presetId) throw invalidRequest("Missing model preset id in path");

  // The Agent SDK probes the base URL for connectivity (a bare HEAD/GET with
  // no `/v1/...` subpath) before issuing real calls. Acknowledge those cheaply
  // without resolving a credential or touching the upstream.
  const subpath = deriveUpstreamSubpath(new URL(c.req.url).pathname, presetId);
  if (c.req.method === "HEAD" || c.req.method === "GET" || !subpath.startsWith("/v1")) {
    return new Response(null, { status: 200 });
  }

  // Resolve the preset → credential + real model + cost, scoped to the org.
  // Must be a Claude Code subscription model: this route injects an OAuth
  // subscription token, which only the claude-code provider may receive.
  const resolved = await loadModel(orgId, presetId);
  if (!resolved) {
    // `loadModel` nulls a model whose OAuth credential is flagged
    // `needsReconnection` (same as one that's truly disabled/missing). For a
    // chat user that's the common "subscription expired" case — surface the
    // actionable reconnect prompt instead of a misleading "not enabled" 400.
    if (await modelNeedsReconnection(orgId, presetId)) {
      logger.warn("claude-code-sdk gateway: subscription needs reconnection (pre-flagged)", {
        presetId,
      });
      return anthropicAuthErrorResponse();
    }
    throw invalidRequest(`Model preset "${presetId}" is not enabled for this org`);
  }
  if (resolved.providerId !== CLAUDE_CODE_PROVIDER_ID) {
    throw invalidRequest(
      `Model preset "${presetId}" is not a Claude Code subscription model (provider: ${resolved.providerId})`,
    );
  }
  if (!resolved.credentialId) {
    throw invalidRequest(`Model preset "${presetId}" has no OAuth credential to resolve`);
  }
  // Defense-in-depth: the claude-code provider pins baseUrl to api.anthropic.com
  // (baseUrlOverridable:false), so this is a no-op today — but it stops the
  // gateway becoming an SSRF hole if that flag is ever flipped, instead of the
  // protection silently depending on a provider def in another repo.
  if (isBlockedUrl(resolved.baseUrl)) {
    throw invalidRequest(`Model base URL targets a blocked network: ${resolved.baseUrl}`);
  }

  const buf = await c.req.arrayBuffer();
  if (buf.byteLength === 0) throw invalidRequest("Request body is empty");
  if (buf.byteLength > maxRequestBytes) {
    throw invalidRequest(`Request body exceeds the maximum of ${maxRequestBytes} bytes`);
  }
  const rawBody = new Uint8Array(buf);

  // Resolve a fresh subscription token (auto-refresh, Redis-deduped). A
  // credential needing reconnection throws `gone()` → translate it into an
  // Anthropic-native 401 the SDK surfaces as an actionable reconnect prompt.
  let token: Awaited<ReturnType<typeof resolveOAuthTokenForSidecar>>;
  try {
    token = await resolveOAuthTokenForSidecar(resolved.credentialId, orgId);
  } catch (err) {
    const authError = subscriptionAuthErrorResponse(err);
    if (authError) {
      logger.warn("claude-code-sdk gateway: subscription needs reconnection", {
        presetId,
        code: err instanceof ApiError ? err.code : undefined,
      });
      return authError;
    }
    throw err;
  }

  const upstreamUrl = `${resolved.baseUrl.replace(/\/+$/, "")}${subpath}${new URL(c.req.url).search}`;
  const upstreamHeaders = buildSubscriptionHeaders(c.req.raw.headers, token.accessToken);

  const principal: LlmProxyPrincipal = apiKeyId
    ? { kind: "api_key", apiKeyId, orgId, userId }
    : { kind: "jwt_user", userId, orgId };
  const runId = c.req.header("X-Run-Id") || null;
  const started = Date.now();

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: c.req.method,
      headers: upstreamHeaders,
      body: rawBody,
    });
  } catch (err) {
    logger.error("claude-code-sdk gateway: upstream fetch failed", {
      presetId,
      error: getErrorMessage(err),
    });
    throw err;
  }

  // Errors: surface verbatim, never meter (no tokens produced).
  if (!upstream.ok) {
    const errorBody = await upstream.text();
    logger.warn("claude-code-sdk gateway: upstream error", {
      presetId,
      status: upstream.status,
    });
    return new Response(errorBody, {
      status: upstream.status,
      headers: cloneResponseHeaders(upstream.headers),
    });
  }

  const isSse = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  if (isSse && upstream.body) {
    const [clientStream, tapStream] = upstream.body.tee();
    void tapSseUsage(tapStream, anthropicMessagesAdapter).then((usage) =>
      recordProxyUsage({
        principal,
        runId,
        presetId,
        resolved,
        usage,
        durationMs: Date.now() - started,
      }),
    );
    return new Response(clientStream, {
      status: upstream.status,
      headers: cloneResponseHeaders(upstream.headers),
    });
  }

  // Non-streaming JSON: buffer once, meter, forward an identical copy.
  const bodyText = await upstream.text();
  try {
    const usage = anthropicMessagesAdapter.parseJsonUsage(JSON.parse(bodyText));
    await recordProxyUsage({
      principal,
      runId,
      presetId,
      resolved,
      usage,
      durationMs: Date.now() - started,
    });
  } catch {
    // Non-JSON 2xx (unexpected) — forward without metering.
  }
  return new Response(bodyText, {
    status: upstream.status,
    headers: cloneResponseHeaders(upstream.headers),
  });
}
