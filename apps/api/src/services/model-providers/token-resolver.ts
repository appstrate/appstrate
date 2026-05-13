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

import {
  parseTokenResponse,
  parseTokenErrorResponse,
  buildTokenHeaders,
  buildTokenBody,
} from "@appstrate/connect";
import type { ModelProviderDefinition as ModelProviderConfig } from "@appstrate/core/module";
import {
  findMissingIdentityClaims,
  loadCredentialRow,
  markCredentialNeedsReconnection,
  pickOAuthTokenResponse,
  updateOAuthCredentialTokens,
  type OAuthBlob,
} from "./credentials.ts";
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
  // Defense-in-depth: `loadCredentialRow` enforces `expectedOrgId` when
  // provided. Even if the route's `assertOAuthModelCredential` gate is
  // ever bypassed by a refactor, the data layer refuses to surface a
  // credential outside the caller's org.
  const loaded = await loadCredentialRow(credentialId, expectedOrgId);
  if (!loaded) {
    throw notFound(`OAuth model provider credential not found: ${credentialId}`);
  }
  if (!loaded.config || loaded.config.authMode !== "oauth2") {
    throw notFound(
      `Credential ${credentialId} references provider ${loaded.providerId} which is not OAuth-enabled`,
    );
  }
  if (loaded.blob.kind !== "oauth") {
    throw notFound(`Credential ${credentialId} stores api_key data, not OAuth tokens`);
  }

  return {
    credentialId: loaded.id,
    orgId: loaded.orgId,
    blob: loaded.blob,
    config: loaded.config as ModelProviderConfig & { authMode: "oauth2" },
  };
}

function buildResolvedToken(state: CredentialState): OAuthTokenResponse {
  // Trust the stored identity claims — they were populated by
  // `extractTokenIdentity` at import time and re-populated on every
  // refresh in `doRefresh`. Re-decoding the JWT on every sidecar poll
  // would burn cycles for no gain.
  const missing = findMissingIdentityClaims(state.config.requiredIdentityClaims, {
    accountId: state.blob.accountId,
    email: state.blob.email,
  });
  if (missing.length > 0) {
    logger.warn("oauth model provider: required identity claim(s) missing in stored creds", {
      credentialId: state.credentialId,
      providerId: state.config.providerId,
      missing,
    });
  }
  return pickOAuthTokenResponse(state.blob);
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

  // Re-extract identity from the freshly-issued access token. Providers
  // that re-issue a token on every refresh make the wire token the source
  // of truth; fall back to the previously-stored value otherwise.
  const claims = state.config.hooks?.extractTokenIdentity?.(parsed.accessToken) ?? null;
  const accountId = claims?.accountId ?? state.blob.accountId;
  const email = claims?.email ?? state.blob.email;
  const missing = findMissingIdentityClaims(state.config.requiredIdentityClaims, {
    accountId,
    email,
  });
  if (missing.length > 0) {
    logger.warn("oauth model provider: required identity claim(s) missing after refresh", {
      credentialId,
      providerId: state.config.providerId,
      hookReturnedClaims: claims !== null,
      missing,
    });
  }
  const expiresAtMs = parsed.expiresAt ? new Date(parsed.expiresAt).getTime() : null;
  await updateOAuthCredentialTokens(state.orgId, credentialId, {
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken ?? state.blob.refreshToken,
    expiresAt: expiresAtMs,
    ...(accountId ? { accountId } : {}),
  });

  return pickOAuthTokenResponse({
    accessToken: parsed.accessToken,
    expiresAt: expiresAtMs,
    accountId,
  });
}
