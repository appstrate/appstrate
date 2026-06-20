// SPDX-License-Identifier: Apache-2.0

/**
 * Codex (ChatGPT) subscription **CLI gateway** —
 * `ALL /api/llm-proxy/codex-sdk/:presetId/*`.
 *
 * The credential-injection gateway the official `codex` CLI is pointed at via
 * `-c chatgpt_base_url=…`. The Codex counterpart of
 * {@link ./claude-code-sdk-gateway.ts}, and ToS-clean for the same reason:
 *
 *   - **No forging.** The official `codex` binary signs its OWN client
 *     fingerprint (`originator: codex_exec`) and sends its own request shape.
 *     This gateway forges nothing — it only swaps the placeholder bearer for the
 *     real subscription token and stamps the real `chatgpt-account-id`. (This is
 *     the chat-side twin of the runner's sidecar `oauth` codex mode.)
 *   - **Forward verbatim.** Codex's ChatGPT-mode startup is chatty (an
 *     app-server MCP `initialize`, analytics, plugin lookups) and only then the
 *     `/responses` inference call. All of these hit `chatgpt_base_url`, so we
 *     forward EVERY subpath to the real backend unchanged — exactly what the CLI
 *     would do talking to chatgpt.com directly.
 *   - **Credential isolation.** The spawned `codex` binary only ever holds a
 *     placeholder access token (in its `CODEX_HOME/auth.json`); the real
 *     subscription token is resolved here, server-side, and never enters the
 *     subprocess environment.
 *   - **No metering here.** Token usage is driver-authoritative: the chat codex
 *     engine reads it from the CLI's `turn.completed.usage` event and records it
 *     once. Metering the opaque upstream SSE too would double-count.
 *
 * FIRST-PARTY ONLY — same trust boundary as the in-container sidecar: a personal
 * subscription is never spendable through an API key or external token.
 */

import type { Context } from "hono";
import { loadModel, modelNeedsReconnection } from "../org-models.ts";
import { resolveOAuthTokenForSidecar } from "../model-providers/token-resolver.ts";
import { cloneResponseHeaders } from "./metering.ts";
import { ApiError, invalidRequest } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { isBlockedUrl } from "@appstrate/core/ssrf";
import type { AppEnv } from "../../types/index.ts";

/** Provider id of the Codex (ChatGPT Plus/Pro/Business) subscription credential. */
export const CODEX_PROVIDER_ID = "codex";

/** URL prefix this gateway is mounted under (within the llm-proxy router). */
const ROUTE_PREFIX = "/api/llm-proxy/codex-sdk";

/**
 * Derive the upstream subpath from the full request path — everything the CLI
 * appended after `…/codex-sdk/:presetId`. Forwarded to the backend verbatim
 * (codex uses several path roots: `/responses`, `/api/codex/ps/mcp`,
 * `/codex/analytics-events/events`, …). Pure for unit testing.
 */
export function deriveCodexSubpath(fullPath: string, presetId: string): string {
  const base = `${ROUTE_PREFIX}/${presetId}`;
  const idx = fullPath.indexOf(base);
  if (idx === -1) return "/";
  const rest = fullPath.slice(idx + base.length);
  return rest.length > 0 ? rest : "/";
}

/**
 * Build the upstream headers: keep the CLI's own headers (originator,
 * OpenAI-Beta, content-type, accept), swap in the real Bearer token, stamp the
 * real `chatgpt-account-id`, and drop the bits that must not leak
 * (placeholder bearer overwritten; host/content-length/accept-encoding
 * stripped so Bun's auto-decompression stays consistent). Pure for unit testing.
 */
export function buildCodexHeaders(
  incoming: Headers,
  accessToken: string,
  accountId: string | undefined,
): Headers {
  const headers = new Headers(incoming);
  headers.set("authorization", `Bearer ${accessToken}`);
  if (accountId) headers.set("chatgpt-account-id", accountId);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("accept-encoding");
  return headers;
}

/** A 401 JSON the CLI surfaces as an auth failure → actionable reconnect prompt. */
export function codexAuthErrorResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        type: "authentication_error",
        message: "Reconnectez votre abonnement ChatGPT — la connexion a expiré ou été révoquée.",
      },
    }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

/** Translate a 410 token-resolution failure into {@link codexAuthErrorResponse}.
 * Returns null for any other error so the caller rethrows. Pure for testing. */
export function codexSubscriptionAuthError(err: unknown): Response | null {
  if (!(err instanceof ApiError) || err.status !== 410) return null;
  return codexAuthErrorResponse();
}

/**
 * Handle one upstream call from the Codex CLI. The route layer has already
 * enforced bearer-only + first-party + rate limit + `llm-proxy:call`.
 */
export async function handleCodexSdkGateway(
  c: Context<AppEnv>,
  maxRequestBytes: number,
): Promise<Response> {
  const orgId = c.get("orgId");
  const presetId = c.req.param("presetId");
  if (!presetId) throw invalidRequest("Missing model preset id in path");

  const subpath = deriveCodexSubpath(new URL(c.req.url).pathname, presetId);

  // Resolve the preset → credential + real model + cost, scoped to the org.
  const resolved = await loadModel(orgId, presetId);
  if (!resolved) {
    if (await modelNeedsReconnection(orgId, presetId)) {
      logger.warn("codex-sdk gateway: subscription needs reconnection (pre-flagged)", { presetId });
      return codexAuthErrorResponse();
    }
    throw invalidRequest(`Model preset "${presetId}" is not enabled for this org`);
  }
  if (resolved.providerId !== CODEX_PROVIDER_ID) {
    throw invalidRequest(
      `Model preset "${presetId}" is not a Codex subscription model (provider: ${resolved.providerId})`,
    );
  }
  if (!resolved.credentialId) {
    throw invalidRequest(`Model preset "${presetId}" has no OAuth credential to resolve`);
  }
  // Defense-in-depth: the codex provider pins baseUrl to chatgpt.com
  // (baseUrlOverridable:false), so this is a no-op today — but it stops the
  // gateway becoming an SSRF hole if that flag is ever flipped.
  if (isBlockedUrl(resolved.baseUrl)) {
    throw invalidRequest(`Model base URL targets a blocked network: ${resolved.baseUrl}`);
  }

  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > maxRequestBytes) {
    throw invalidRequest(`Request body exceeds the maximum of ${maxRequestBytes} bytes`);
  }
  const rawBody = buf.byteLength > 0 ? new Uint8Array(buf) : undefined;

  // Resolve a fresh subscription token (auto-refresh, Redis-deduped). A
  // credential needing reconnection throws gone() (410) → CLI-facing 401.
  let token: Awaited<ReturnType<typeof resolveOAuthTokenForSidecar>>;
  try {
    token = await resolveOAuthTokenForSidecar(resolved.credentialId, orgId);
  } catch (err) {
    const authError = codexSubscriptionAuthError(err);
    if (authError) {
      logger.warn("codex-sdk gateway: subscription needs reconnection", { presetId });
      return authError;
    }
    throw err;
  }

  const upstreamUrl = `${resolved.baseUrl.replace(/\/+$/, "")}${subpath}${new URL(c.req.url).search}`;
  const upstreamHeaders = buildCodexHeaders(c.req.raw.headers, token.accessToken, token.accountId);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: c.req.method,
      headers: upstreamHeaders,
      body: rawBody,
    });
  } catch (err) {
    logger.error("codex-sdk gateway: upstream fetch failed", {
      presetId,
      error: getErrorMessage(err),
    });
    throw err;
  }

  // Forward the upstream response verbatim (streaming SSE or JSON). Usage is
  // metered driver-side from the CLI's turn.completed event, not here.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: cloneResponseHeaders(upstream.headers),
  });
}
