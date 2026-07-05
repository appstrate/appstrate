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
 *     prelude, no fingerprint headers. We only swap the bearer for the real
 *     subscription token + add the OAuth beta. (This is the chat-side twin of
 *     the runner's sidecar `oauth` mode.) This is an official-binary path, NOT
 *     a compliance certification: powering a product with a personal Claude
 *     subscription needs prior Anthropic approval, the policy flipped repeatedly
 *     in 2026, and it is an operator opt-in grey-zone choice. See
 *     docs/architecture/SUBSCRIPTION_COMPLIANCE.md.
 *   - **No body rewrite.** The SDK sends the real upstream model id and its
 *     own system prompt; we forward the body verbatim. The preset id comes
 *     from the URL (it carries the credential + cost), not `body.model`.
 *   - **Credential isolation.** The spawned `claude` binary only ever holds a
 *     placeholder bearer (a turn-scoped chat-loopback token); the real
 *     subscription token is resolved here, server-side, and never enters the
 *     binary's environment.
 *
 * LOOPBACK ONLY — driven exclusively by the chat module's in-process loopback
 * bearer (not API keys, not dashboard tokens), so a personal subscription is
 * never spendable as a bare non-official-client proxy. See lib/bearer-only.ts.
 */

import type { Context } from "hono";
import { anthropicMessagesAdapter } from "./anthropic.ts";
import { forwardMeteredResponse } from "./metering.ts";
import { loadModel, modelNeedsReconnection, type ResolvedModel } from "../org-models.ts";
import { resolveOAuthTokenForSidecar } from "../model-providers/token-resolver.ts";
import { markCredentialNeedsReconnection } from "../model-providers/credentials.ts";
import { buildLlmProxyPrincipal } from "./types.ts";
import { ApiError, invalidRequest } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { isBlockedUrl } from "@appstrate/core/ssrf";
import {
  anthropicAuthErrorResponse,
  applyClaudeOauthGatewayHeaders,
} from "@appstrate/core/claude-oauth-gateway";
import type { AppEnv } from "../../types/index.ts";

/** Provider id of the Claude Pro/Max/Team subscription credential. */
export const CLAUDE_CODE_PROVIDER_ID = "claude-code";

// The shared, no-forge Anthropic OAuth-gateway policy (OAuth-beta merge, bearer
// swap, x-api-key drop, auth-error envelope) lives in
// `@appstrate/core/claude-oauth-gateway` so this chat gateway and the sidecar
// run gateway cannot drift.

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
  headers.delete("host");
  headers.delete("content-length");
  // Ask the upstream for identity encoding — Bun's fetch auto-decompresses,
  // and forwarding a gzip body the client won't re-decompress trips ZlibError.
  headers.delete("accept-encoding");
  // Shared no-forge gateway policy: drop x-api-key, force the real bearer, and
  // merge the OAuth beta while preserving the caller's own betas.
  applyClaudeOauthGatewayHeaders(headers, accessToken);
  if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  return headers;
}

/**
 * Translate a token-resolution failure into {@link anthropicAuthErrorResponse}
 * when it is a `gone()` (HTTP 410) — a refresh-time revocation discovered by
 * `resolveOAuthTokenForSidecar`. (The pre-flagged `needsReconnection` case is
 * caught earlier, at `loadModel`, via `modelNeedsReconnection`.) Any other error
 * returns `null` so the caller rethrows it unchanged (an unexpected failure must
 * not masquerade as an auth problem). Exported for unit testing.
 */
export function subscriptionAuthErrorResponse(err: unknown): Response | null {
  if (!(err instanceof ApiError) || err.status !== 410) return null;
  return anthropicAuthErrorResponse();
}

interface ResolvedClaudeSubscription {
  resolved: ResolvedModel;
  token: Awaited<ReturnType<typeof resolveOAuthTokenForSidecar>>;
}

/**
 * Resolve the preset → claude-code credential + real model + cost + a fresh
 * subscription token, scoped to the org. Returns a ready-to-return error
 * `Response` for the two reconnect paths (pre-flagged + refresh-time 410); any
 * other failure throws. Previously a generic `resolveSubscriptionToken` helper
 * shared "with the Codex vend", but the Codex path vends sidecar-side and never
 * used it — so this is inlined claude-code-specific (its sole caller).
 */
async function resolveClaudeSubscriptionToken(
  orgId: string,
  presetId: string,
): Promise<ResolvedClaudeSubscription | Response> {
  const logLabel = "claude-code-sdk gateway";

  const resolved = await loadModel(orgId, presetId);
  if (!resolved) {
    if (await modelNeedsReconnection(orgId, presetId)) {
      logger.warn(`${logLabel}: subscription needs reconnection (pre-flagged)`, { presetId });
      return anthropicAuthErrorResponse();
    }
    throw invalidRequest(`Model preset "${presetId}" is not enabled for this org`);
  }
  if (resolved.providerId !== CLAUDE_CODE_PROVIDER_ID) {
    // The backing provider id must not be caller-facing (alias masking) —
    // keep it in server logs only.
    logger.warn(`${logLabel}: preset is not a claude-code subscription model`, {
      presetId,
      providerId: resolved.providerId,
    });
    throw invalidRequest(`Model preset "${presetId}" is not a Claude Code subscription model`);
  }
  if (!resolved.credentialId) {
    throw invalidRequest(`Model preset "${presetId}" has no OAuth credential to resolve`);
  }

  let token: Awaited<ReturnType<typeof resolveOAuthTokenForSidecar>>;
  try {
    token = await resolveOAuthTokenForSidecar(resolved.credentialId, orgId);
  } catch (err) {
    const authError = subscriptionAuthErrorResponse(err);
    if (authError) {
      logger.warn(`${logLabel}: subscription needs reconnection`, { presetId });
      return authError;
    }
    throw err;
  }

  return { resolved, token };
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

  // Resolve the preset → credential + real model + cost + a fresh subscription
  // token, scoped to the org. The two reconnect paths (pre-flagged + refresh-time
  // 410) return an Anthropic-native 401 the SDK surfaces as a reconnect prompt.
  const result = await resolveClaudeSubscriptionToken(orgId, presetId);
  if (result instanceof Response) return result;
  const { resolved, token } = result;

  // Defense-in-depth: the claude-code provider pins baseUrl to api.anthropic.com
  // (baseUrlOverridable:false), so this is a no-op today — but it stops the
  // gateway becoming an SSRF hole if that flag is ever flipped, instead of the
  // protection silently depending on a provider def in another repo.
  if (isBlockedUrl(resolved.baseUrl)) {
    // The resolved base URL is the real backing endpoint — server-log-only;
    // the caller-facing message must not embed it.
    logger.error("claude-code-sdk gateway: refused blocked upstream (SSRF)", {
      presetId,
      baseUrl: resolved.baseUrl,
    });
    throw invalidRequest(
      `Model preset "${presetId}" resolves to a blocked address — refusing to proxy.`,
    );
  }

  const buf = await c.req.arrayBuffer();
  if (buf.byteLength === 0) throw invalidRequest("Request body is empty");
  if (buf.byteLength > maxRequestBytes) {
    throw invalidRequest(`Request body exceeds the maximum of ${maxRequestBytes} bytes`);
  }
  const rawBody = new Uint8Array(buf);

  const upstreamUrl = `${resolved.baseUrl.replace(/\/+$/, "")}${subpath}${new URL(c.req.url).search}`;
  const upstreamHeaders = buildSubscriptionHeaders(c.req.raw.headers, token.accessToken);

  const principal = buildLlmProxyPrincipal({ apiKeyId, orgId, userId });
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

  // Upstream rejected the subscription token (revoked / scope changed) — not
  // just a refresh-time 410. Flag the credential needs-reconnection (so the
  // dashboard prompts a reconnect, same end state as the 410 path) and hand the
  // SDK an Anthropic-native auth error it surfaces as an actionable reconnect
  // message, instead of forwarding a raw 401/403 the chat can't interpret.
  if ((upstream.status === 401 || upstream.status === 403) && resolved.credentialId) {
    logger.warn("claude-code-sdk gateway: upstream rejected subscription token", {
      presetId,
      status: upstream.status,
    });
    await markCredentialNeedsReconnection(orgId, resolved.credentialId).catch((err) =>
      logger.error("claude-code-sdk gateway: failed to flag credential needs-reconnection", {
        credentialId: resolved.credentialId,
        error: getErrorMessage(err),
      }),
    );
    // Drain the upstream body so the connection can be reused.
    await upstream.body?.cancel().catch(() => undefined);
    return anthropicAuthErrorResponse();
  }

  // Forward + meter (no alias-swap, no response-cache for the subscription path).
  return forwardMeteredResponse(
    upstream,
    anthropicMessagesAdapter,
    { principal, runId, presetId, resolved, started },
    {
      logLabel: "claude-code-sdk gateway",
      onUpstreamError: (status) =>
        logger.warn("claude-code-sdk gateway: upstream error", { presetId, status }),
    },
  );
}
