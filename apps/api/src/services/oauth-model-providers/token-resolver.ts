// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth Model Providers — token resolution and refresh.
 *
 * Backs the `/internal/oauth-token/:credentialId(/refresh)?` routes that the
 * sidecar polls during `/llm/*` request lifecycle (cf. SPEC §5.2). Reads
 * from the unified `model_provider_credentials` table; the row's blob has
 * `kind: "oauth"` and carries the access/refresh tokens.
 *
 * Concurrency: a single in-process `Map<credentialId, Promise<...>>` mutex
 * serializes refresh attempts for the same credential — multiple sidecars
 * hitting the API at the same time can each end up calling the provider,
 * so this singleflight is best-effort defense in depth (the sidecar's own
 * cache provides the primary deduplication).
 */

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials } from "@appstrate/db/schema";
import {
  decryptCredentials,
  parseTokenResponse,
  parseTokenErrorResponse,
  buildTokenHeaders,
  buildTokenBody,
} from "@appstrate/connect";
import {
  decodeCodexJwtPayload,
  getModelProviderConfig,
  type ModelProviderConfig,
} from "./registry.ts";
import {
  markCredentialNeedsReconnection,
  updateOAuthCredentialTokens,
  type OAuthBlob,
} from "../model-provider-credentials.ts";
import { gone, notFound } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";
import { hasRedis } from "../../infra/mode.ts";
import { getRedisConnection } from "../../lib/redis.ts";
import { randomBytes } from "node:crypto";
import { OAUTH_REFRESH_LEAD_MS, type OAuthTokenResponse } from "@appstrate/core/sidecar-types";

/**
 * Distributed-lock TTL in seconds. Sized as `30s network timeout` + slack.
 * If a holder crashes, the lock auto-expires so the next caller can refresh.
 * Lua-released early when the holder finishes — TTL is the safety net.
 */
const REFRESH_LOCK_TTL_SECONDS = 45;

/**
 * In-process singleflight — collapses concurrent refresh callers WITHIN a
 * single API instance. Across instances, the Redis lock below serializes.
 * On Tier 0/1 (no Redis) the platform is single-instance by definition, so
 * this map is the only serialization needed.
 */
const inflightRefreshes = new Map<string, Promise<OAuthTokenResponse>>();

/**
 * Lua script for safe lock release: only deletes the key if its value
 * matches the lock-id we wrote. Prevents releasing a lock acquired by
 * another instance after our TTL expired.
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

/** Credential row + decrypted blob + registry overlay. Internal helper return shape. */
interface CredentialState {
  credentialId: string;
  orgId: string;
  blob: OAuthBlob;
  config: ModelProviderConfig & { authMode: "oauth2" };
}

async function loadCredentialState(
  credentialId: string,
  expectedOrgId?: string,
): Promise<CredentialState> {
  const [row] = await db
    .select({
      id: modelProviderCredentials.id,
      orgId: modelProviderCredentials.orgId,
      providerId: modelProviderCredentials.providerId,
      credentialsEncrypted: modelProviderCredentials.credentialsEncrypted,
    })
    .from(modelProviderCredentials)
    .where(eq(modelProviderCredentials.id, credentialId))
    .limit(1);
  if (!row) {
    throw notFound(`OAuth model provider credential not found: ${credentialId}`);
  }
  // Defense-in-depth: even if the route's `assertOAuthModelCredential`
  // gate is ever bypassed by a refactor, the data layer refuses to surface
  // a credential outside the caller's org. Internally this branch is dead
  // when callers pass `expectedOrgId` correctly — its job is to make
  // accidental cross-org access fail loudly during refactors instead of
  // silently leaking a token.
  if (expectedOrgId !== undefined && row.orgId !== expectedOrgId) {
    throw notFound(`OAuth model provider credential not found: ${credentialId}`);
  }

  // Unfiltered: existing credentials for disabled providers must keep working.
  // Once a credential row exists, the token resolver continues to serve it
  // regardless of `MODEL_PROVIDERS_DISABLED` — the admin disables NEW
  // creation, not in-flight runs.
  const config = getModelProviderConfig(row.providerId);
  if (!config || config.authMode !== "oauth2") {
    throw notFound(
      `Credential ${credentialId} references provider ${row.providerId} which is not OAuth-enabled`,
    );
  }

  let blob: OAuthBlob;
  try {
    const decrypted = decryptCredentials<OAuthBlob>(row.credentialsEncrypted);
    if (decrypted.kind !== "oauth") {
      throw notFound(`Credential ${credentialId} stores api_key data, not OAuth tokens`);
    }
    blob = decrypted;
  } catch (err) {
    throw notFound(
      `Credential ${credentialId} ciphertext failed to decrypt: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    credentialId: row.id,
    orgId: row.orgId,
    blob,
    config: config as ModelProviderConfig & { authMode: "oauth2" },
  };
}

/**
 * Resolve `chatgpt_account_id` for a Codex credential, decoding the access
 * token as a defense-in-depth fallback when the stored value is missing.
 * Returns `undefined` for non-Codex providers (the field is unused there).
 *
 * Always prefers the freshly-decoded JWT over the stored value — Codex
 * re-issues a JWT on every token rotation, so the wire token is the source
 * of truth. Falls back to stored only when the JWT is unparseable (which
 * shouldn't happen for genuine Codex tokens). Logs once at warn level when
 * both sources fail to surface an id (visibility on broken rows).
 */
function resolveCodexAccountId(
  providerId: string,
  accessToken: string,
  stored: string | undefined,
  credentialId: string,
): string | undefined {
  if (providerId !== "codex") return undefined;
  const decoded = decodeCodexJwtPayload(accessToken);
  const fromJwt = decoded?.chatgpt_account_id;
  if (fromJwt) return fromJwt;
  if (stored) return stored;
  logger.warn("oauth model provider: accountId missing in stored creds", {
    credentialId,
    providerId,
    jwtParsed: decoded !== null,
  });
  return undefined;
}

/**
 * Map registry config + fresh token material to the sidecar's wire shape.
 *
 * The `authMode: "oauth2"` constraint guarantees `apiShape` is one of the
 * OAuth-reachable shapes (never `openai-chat`, which is API-key-only).
 */
function toResolvedToken(
  config: ModelProviderConfig & { authMode: "oauth2" },
  accessToken: string,
  expiresAt: number | null,
  accountId: string | undefined,
): OAuthTokenResponse {
  return {
    accessToken,
    expiresAt,
    apiShape: config.apiShape as OAuthTokenResponse["apiShape"],
    baseUrl: config.defaultBaseUrl,
    rewriteUrlPath: config.rewriteUrlPath,
    forceStream: config.forceStream,
    forceStore: config.forceStore,
    accountId,
    providerId: config.providerId,
  };
}

function buildResolvedToken(state: CredentialState): OAuthTokenResponse {
  const accountId = resolveCodexAccountId(
    state.config.providerId,
    state.blob.accessToken,
    state.blob.accountId,
    state.credentialId,
  );
  return toResolvedToken(state.config, state.blob.accessToken, state.blob.expiresAt, accountId);
}

/**
 * Resolve a fresh access token for the sidecar. Refreshes proactively if
 * the token expires within {@link OAUTH_REFRESH_LEAD_MS}.
 *
 * `expectedOrgId` is forwarded to {@link loadCredentialState} as
 * defense-in-depth — see that function's comment.
 *
 * Throws `gone(needsReconnection: true)` when the credential is flagged as
 * needing reconnection — sidecar surfaces this as 401 to the agent.
 */
export async function resolveOAuthTokenForSidecar(
  credentialId: string,
  expectedOrgId?: string,
): Promise<OAuthTokenResponse> {
  const state = await loadCredentialState(credentialId, expectedOrgId);
  if (state.blob.needsReconnection) {
    throw gone(
      "OAUTH_CONNECTION_NEEDS_RECONNECTION",
      `OAuth credential ${credentialId} needs reconnection`,
    );
  }

  const expiresInMs = state.blob.expiresAt ? state.blob.expiresAt - Date.now() : 0;
  if (state.blob.expiresAt && expiresInMs > OAUTH_REFRESH_LEAD_MS) {
    return buildResolvedToken(state);
  }

  return forceRefreshOAuthModelProviderToken(credentialId, expectedOrgId);
}

/**
 * Force a refresh of the access token regardless of expiry. Two layers of
 * deduplication guard against concurrent refreshes:
 *
 *  1. **In-process singleflight** (`inflightRefreshes`) — collapses callers
 *     within the same API instance.
 *  2. **Distributed Redis lock** (`oauth-refresh:${credentialId}`) — serializes
 *     across instances. Without it, multiple platforms behind a load
 *     balancer would each hit the upstream `/oauth/token` endpoint
 *     concurrently; OpenAI/Anthropic both rotate `refresh_token` on use, so
 *     the slow caller writes a now-invalid `refresh_token` to the DB and
 *     the credential gets flagged `needsReconnection=true` at the next
 *     refresh attempt. After acquiring the Redis lock, we **re-read** the
 *     credential row to pick up any `accessToken`/`refreshToken` already
 *     written by the lock-winner, and short-circuit if the token is now
 *     fresh enough — otherwise we'd burn the just-rotated `refresh_token`.
 *
 * On Tier 0/1 (no Redis) the platform runs single-instance, so the
 * in-process singleflight is sufficient and the lock is skipped.
 *
 * On `invalid_grant` (refresh token revoked), flips `needsReconnection=true`
 * on the row and throws `gone()`.
 */
export async function forceRefreshOAuthModelProviderToken(
  credentialId: string,
  expectedOrgId?: string,
): Promise<OAuthTokenResponse> {
  const inflight = inflightRefreshes.get(credentialId);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      return await refreshUnderDistributedLock(credentialId, expectedOrgId);
    } finally {
      inflightRefreshes.delete(credentialId);
    }
  })();
  inflightRefreshes.set(credentialId, promise);
  return promise;
}

/**
 * Acquire the distributed refresh lock (if Redis is available), then call
 * {@link doRefresh}. After acquiring the lock, re-read the credential to
 * detect a refresh that happened on another instance while we were waiting:
 * if the stored token is now fresh enough, return it without burning the
 * (potentially just-rotated) refresh_token.
 */
async function refreshUnderDistributedLock(
  credentialId: string,
  expectedOrgId?: string,
): Promise<OAuthTokenResponse> {
  if (!hasRedis()) {
    return doRefresh(credentialId, expectedOrgId);
  }

  const redis = getRedisConnection();
  const lockKey = `oauth-refresh:${credentialId}`;
  const lockId = randomBytes(16).toString("hex");
  const acquireDeadline = Date.now() + 30_000;
  let acquired = false;

  while (Date.now() < acquireDeadline) {
    const result = await redis.set(lockKey, lockId, "EX", REFRESH_LOCK_TTL_SECONDS, "NX");
    if (result === "OK") {
      acquired = true;
      break;
    }
    // Wait briefly before retrying — the lock-winner is talking to upstream
    // (~hundreds of ms) so polling at 100ms keeps tail latency reasonable
    // without hammering Redis.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!acquired) {
    logger.warn("oauth model provider: refresh lock acquisition timed out, proceeding unlocked", {
      credentialId,
    });
    return doRefresh(credentialId, expectedOrgId);
  }

  try {
    // Lock-winner may have written a fresh token while we were waiting.
    // Re-read; if the access token is now within the refresh window, the
    // resolver caller still gets a valid token without us calling upstream.
    const state = await loadCredentialState(credentialId, expectedOrgId);
    if (state.blob.needsReconnection) {
      throw gone(
        "OAUTH_CONNECTION_NEEDS_RECONNECTION",
        `OAuth credential ${credentialId} needs reconnection`,
      );
    }
    if (state.blob.expiresAt && state.blob.expiresAt - Date.now() > OAUTH_REFRESH_LEAD_MS) {
      return buildResolvedToken(state);
    }
    return await doRefresh(credentialId, expectedOrgId);
  } finally {
    // Best-effort release. If the EVAL fails (Redis hiccup), the TTL
    // ensures the lock auto-expires within REFRESH_LOCK_TTL_SECONDS.
    try {
      await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, lockId);
    } catch (err) {
      logger.warn("oauth model provider: refresh lock release failed", {
        credentialId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function doRefresh(
  credentialId: string,
  expectedOrgId?: string,
): Promise<OAuthTokenResponse> {
  const state = await loadCredentialState(credentialId, expectedOrgId);
  if (state.blob.needsReconnection) {
    throw gone(
      "OAUTH_CONNECTION_NEEDS_RECONNECTION",
      `OAuth credential ${credentialId} needs reconnection`,
    );
  }
  if (!state.blob.refreshToken) {
    await markCredentialNeedsReconnection(state.orgId, credentialId);
    throw gone(
      "OAUTH_REFRESH_TOKEN_MISSING",
      `OAuth credential ${credentialId} has no refresh_token — cannot refresh`,
    );
  }

  const tokenUrl = state.config.oauth!.refreshUrl;
  const clientId = state.config.oauth!.clientId;

  const tokenParams: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: state.blob.refreshToken,
    client_id: clientId,
  };

  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: buildTokenHeaders(undefined, clientId, "", undefined),
      body: buildTokenBody(tokenParams),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(
      `Token refresh network error for '${state.config.providerId}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!response.ok) {
    const text = await response.text();
    const classification = parseTokenErrorResponse(response.status, text);
    if (classification.kind === "revoked") {
      await markCredentialNeedsReconnection(state.orgId, credentialId);
      throw gone(
        "OAUTH_REFRESH_REVOKED",
        `OAuth refresh revoked for ${state.config.providerId} (${credentialId}): ${
          classification.error ?? "invalid_grant"
        }`,
      );
    }
    throw new Error(
      `Token refresh failed for '${state.config.providerId}': ${
        classification.error ?? `HTTP ${response.status}`
      }`,
    );
  }

  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`Refresh returned non-JSON response for '${state.config.providerId}'`);
  }

  // Preserve the existing refresh_token if the provider didn't return a new
  // one (Anthropic does, OpenAI rotates them too, but be defensive).
  const parsed = parseTokenResponse(data, undefined, state.blob.refreshToken);

  const accountId = resolveCodexAccountId(
    state.config.providerId,
    parsed.accessToken,
    state.blob.accountId,
    credentialId,
  );
  const expiresAtMs = parsed.expiresAt ? new Date(parsed.expiresAt).getTime() : null;
  await updateOAuthCredentialTokens(state.orgId, credentialId, {
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken ?? state.blob.refreshToken,
    expiresAt: expiresAtMs,
    ...(accountId ? { accountId } : {}),
  });

  return toResolvedToken(state.config, parsed.accessToken, expiresAtMs, accountId);
}
