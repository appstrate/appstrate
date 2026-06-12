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

import { RefreshError, performRefreshTokenExchange } from "@appstrate/connect";
import type { RefreshExchangeResult } from "@appstrate/connect";
import type { ModelProviderDefinition as ModelProviderConfig } from "@appstrate/core/module";
import {
  findMissingIdentityClaims,
  loadCredentialRow,
  markCredentialNeedsReconnection,
  pickOAuthTokenResponse,
  recordModelCredentialRefreshFailure,
  updateOAuthCredentialTokens,
  type OAuthBlob,
} from "./credentials.ts";
import { getEnv } from "@appstrate/env";
import { gone, notFound } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";
import { dedupedRefresh } from "../../lib/deduped-refresh.ts";
import { OAUTH_REFRESH_LEAD_MS, type OAuthTokenResponse } from "@appstrate/core/sidecar-types";

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
 * deduplication (owned by the shared `dedupedRefresh` helper) guard against
 * concurrent refreshes:
 *
 *  1. **In-process singleflight** — collapses callers within the same API
 *     instance (keyed on `credentialId`).
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
  // Two dedup layers (in-process singleflight + cross-process Redis lock +
  // post-acquire re-read), owned by `dedupedRefresh`. The lock-winner may have
  // written a fresh token while we were waiting — the re-read short-circuit
  // returns it without burning the (potentially just-rotated) refresh_token.
  return dedupedRefresh<OAuthTokenResponse>(credentialId, {
    lockKey: `oauth-refresh:${credentialId}`,
    lockLabel: "oauth-refresh",
    reReadFreshness: async () => {
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
      return null;
    },
    doRefresh: () => doRefresh(credentialId, expectedOrgId),
  });
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

  // Model providers (Anthropic/OpenAI) are public OAuth clients — the RFC 7591
  // §2 `token_endpoint_auth_method: "none"` subset. The wire mechanics (build
  // body with client_id only, POST with a 30s timeout, classify revoked vs
  // transient, non-JSON guard, refresh_token-preservation fallback) live in
  // the shared `performRefreshTokenExchange`; only the credential write-back +
  // identity re-extraction stay model-provider-side below.
  let parsed: RefreshExchangeResult["parsed"];
  try {
    ({ parsed } = await performRefreshTokenExchange(
      {
        tokenEndpoint: state.config.oauth!.refreshUrl,
        clientId: state.config.oauth!.clientId,
        clientSecret: "",
        tokenEndpointAuthMethod: "none",
      },
      state.blob.refreshToken,
      { label: `Token refresh for '${state.config.providerId}' (${credentialId})` },
    ));
  } catch (err) {
    // Flip needsReconnection + surface `gone(OAUTH_REFRESH_REVOKED)` on a
    // revoked refresh token; transient failures rethrow as a generic Error.
    if (err instanceof RefreshError && err.kind === "revoked") {
      await markCredentialNeedsReconnection(state.orgId, credentialId);
      throw gone(
        "OAUTH_REFRESH_REVOKED",
        `OAuth refresh revoked for ${state.config.providerId} (${credentialId}): ${
          err.body ?? "invalid_grant"
        }`,
      );
    }
    // Transient failure (network / 5xx / parse). A single transient error is
    // NOT terminal — the cached token may still be valid. But a token that is
    // already expired AND keeps failing refresh is silently dead while the
    // row still looks healthy (same failure mode as the Gmail integration
    // scheduled-run incident, #596). Record the failure;
    // `recordModelCredentialRefreshFailure` escalates to needsReconnection
    // only once the streak crosses the threshold AND the token is expired
    // past the grace window, so a transient upstream blip on a still-valid
    // token never bricks the credential. Same knobs as integrations — one
    // platform-wide policy for "how dead does an OAuth credential have to be".
    const env = getEnv();
    await recordModelCredentialRefreshFailure(
      state.orgId,
      credentialId,
      env.INTEGRATION_REFRESH_MAX_FAILURES,
      env.INTEGRATION_REFRESH_GRACE_SECONDS,
    );
    throw err instanceof Error
      ? err
      : new Error(`Token refresh failed for '${state.config.providerId}': ${String(err)}`);
  }

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
