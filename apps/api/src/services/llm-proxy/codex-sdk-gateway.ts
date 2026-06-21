// SPDX-License-Identifier: Apache-2.0

/**
 * Codex (ChatGPT) subscription **credential vend** —
 * `GET /api/llm-proxy/codex-sdk/:presetId`.
 *
 * Unlike the Claude path, the official `codex` CLI cannot be fully pointed at a
 * forwarding gateway: its models-manager calls `chatgpt.com/backend-api/codex/
 * models` DIRECTLY, ignoring `chatgpt_base_url` (verified empirically against
 * codex-cli 0.141), so a placeholder bearer fails that call and the CLI aborts
 * before inference. The CLI therefore needs the REAL subscription token in its
 * `CODEX_HOME/auth.json`, and talks to chatgpt.com directly.
 *
 * So this endpoint does NOT forward traffic — it VENDS the resolved credential
 * to the first-party loopback caller (the chat codex engine, in-process):
 *   - FIRST-PARTY ONLY (chat-loopback token), same trust boundary as the
 *     in-container sidecar — a personal subscription is never vendable through an
 *     API key or external token.
 *   - resolves the preset → codex credential, refreshes the token server-side
 *     (auto-refresh, Redis-deduped), and returns `{ access_token, account_id }`.
 *   - the engine writes those into a 0600 ephemeral auth.json that only the
 *     spawned `codex` subprocess reads, then deletes it; the token never lands in
 *     the platform DB response cache or any log.
 *
 * Token usage is metered driver-side (the CLI's `turn.completed` event), so
 * there is no proxy metering here.
 */

import type { Context } from "hono";
import { loadModel, modelNeedsReconnection } from "../org-models.ts";
import { resolveOAuthTokenForSidecar } from "../model-providers/token-resolver.ts";
import { ApiError, invalidRequest } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";
import type { AppEnv } from "../../types/index.ts";

/** Provider id of the Codex (ChatGPT Plus/Pro/Business) subscription credential. */
export const CODEX_PROVIDER_ID = "codex";

/** A 401 JSON the engine surfaces as an actionable reconnect prompt. */
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
 * Vend the resolved Codex subscription credential to the first-party loopback
 * caller. The route layer has already enforced bearer-only + first-party +
 * rate limit + `llm-proxy:call`.
 */
export async function handleCodexSdkGateway(c: Context<AppEnv>): Promise<Response> {
  const orgId = c.get("orgId");
  const presetId = c.req.param("presetId");
  if (!presetId) throw invalidRequest("Missing model preset id in path");

  const resolved = await loadModel(orgId, presetId);
  if (!resolved) {
    if (await modelNeedsReconnection(orgId, presetId)) {
      logger.warn("codex vend: subscription needs reconnection (pre-flagged)", { presetId });
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

  let token: Awaited<ReturnType<typeof resolveOAuthTokenForSidecar>>;
  try {
    token = await resolveOAuthTokenForSidecar(resolved.credentialId, orgId);
  } catch (err) {
    const authError = codexSubscriptionAuthError(err);
    if (authError) {
      logger.warn("codex vend: subscription needs reconnection", { presetId });
      return authError;
    }
    throw err;
  }

  // Vend to the in-process loopback caller only. `Cache-Control: no-store` keeps
  // it out of any intermediary cache; the body is never logged.
  return new Response(
    JSON.stringify({ access_token: token.accessToken, account_id: token.accountId ?? null }),
    { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}
