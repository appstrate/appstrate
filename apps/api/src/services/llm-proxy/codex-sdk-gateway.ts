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
import { invalidRequest } from "../../lib/errors.ts";
import type { AppEnv } from "../../types/index.ts";
import { make410AuthTranslator, resolveSubscriptionToken } from "./subscription-token.ts";

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

/** Translate a 410 token-resolution failure into {@link codexAuthErrorResponse}
 * (null for any other error so the caller rethrows). See {@link make410AuthTranslator}. */
export const codexSubscriptionAuthError = make410AuthTranslator(codexAuthErrorResponse);

/**
 * Vend the resolved Codex subscription credential to the first-party loopback
 * caller. The route layer has already enforced bearer-only + first-party +
 * rate limit + `llm-proxy:call`.
 */
export async function handleCodexSdkGateway(c: Context<AppEnv>): Promise<Response> {
  const orgId = c.get("orgId");
  const presetId = c.req.param("presetId");
  if (!presetId) throw invalidRequest("Missing model preset id in path");

  const result = await resolveSubscriptionToken({
    orgId,
    presetId,
    expectedProviderId: CODEX_PROVIDER_ID,
    providerLabel: "Codex",
    authErrorResponse: codexAuthErrorResponse,
    translateAuthError: codexSubscriptionAuthError,
    logLabel: "codex vend",
  });
  if (result instanceof Response) return result;
  const { token } = result;

  // Vend to the in-process loopback caller only. `Cache-Control: no-store` keeps
  // it out of any intermediary cache; the body is never logged.
  return new Response(
    JSON.stringify({ access_token: token.accessToken, account_id: token.accountId ?? null }),
    { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}
