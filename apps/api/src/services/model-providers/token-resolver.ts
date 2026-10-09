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
  pickOAuthToken,
  recordModelCredentialRefreshFailure,
  updateOAuthCredentialTokens,
  type OAuthBlob,
  type OAuthToken,
} from "./credentials.ts";
import { getEnv } from "@appstrate/env";
import { badGateway, gone, notFound, type ApiError } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";
import { dedupedRefresh } from "../../lib/deduped-refresh.ts";
import { CREDENTIAL_FAILURE_SENTENCES } from "../../lib/credential-failure.ts";
import { OAUTH_REFRESH_LEAD_MS, type CredentialFailureCause } from "@appstrate/core/sidecar-types";

/** 410: the credential is flagged `needsReconnection`; the sidecar answers the agent a 401. */
function needsReconnection(credentialId: string, cause: CredentialFailureCause): ApiError {
  return gone(
    "oauth_connection_needs_reconnection",
    `OAuth credential ${credentialId} needs reconnection: ${CREDENTIAL_FAILURE_SENTENCES[cause]}`,
    { cause },
  );
}

/** 502: not refreshed now, the credential stays usable. `err.message` never holds the IdP body. */
function notRefreshed(credentialId: string, cause: CredentialFailureCause, err: Error): ApiError {
  return badGateway(
    `OAuth credential ${credentialId} was not refreshed: ` +
      `${CREDENTIAL_FAILURE_SENTENCES[cause]} (${err.message})`,
    { cause },
  );
}

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
  // An unreadable blob (`blob: null`) is indistinguishable here from a missing
  // credential — same 404; a missing key has already thrown the 503.
  if (!loaded || !loaded.blob) {
    throw notFound(`OAuth model provider credential not found: ${credentialId}`);
  }
  if (loaded.config.authMode !== "oauth2") {
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
    // `ModelProviderDefinition` is not a discriminated union on `authMode`, so
    // the guard above narrows the property but not the object — the assertion
    // is what carries that fact into `CredentialState`.
    config: loaded.config as ModelProviderConfig & { authMode: "oauth2" },
  };
}

function buildResolvedToken(state: CredentialState): OAuthToken {
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
  return pickOAuthToken(state.blob);
}

/**
 * Resolve a fresh access token for the sidecar. Refreshes proactively if
 * the token expires within {@link OAUTH_REFRESH_LEAD_MS}.
 *
 * `expectedOrgId` is forwarded to {@link loadCredentialState} as
 * defense-in-depth — see that function's comment.
 *
 * Throws the 410 `oauth_connection_needs_reconnection` when the credential is
 * flagged as needing reconnection — sidecar surfaces this as 401 to the agent.
 */
export async function resolveOAuthTokenForSidecar(
  credentialId: string,
  expectedOrgId?: string,
): Promise<OAuthToken> {
  const state = await loadCredentialState(credentialId, expectedOrgId);
  if (state.blob.needsReconnection) {
    throw needsReconnection(credentialId, "connection_flagged");
  }

  const expiresInMs = state.blob.expiresAt ? state.blob.expiresAt - Date.now() : 0;
  if (state.blob.expiresAt && expiresInMs > OAUTH_REFRESH_LEAD_MS) {
    return buildResolvedToken(state);
  }

  // PROACTIVE: we got here from the lead-window check above, not from an
  // upstream rejection — so the post-lock freshness short-circuit is welcome.
  // A peer that refreshed while we waited has already produced the token this
  // caller wants, and re-refreshing would burn a healthy rotated credential.
  return forceRefreshOAuthModelProviderToken(credentialId, expectedOrgId, { force: false });
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
 * on the row and throws the 410; a failure that leaves it usable throws a 502.
 * Both carry the `CredentialFailureCause` as the `cause` extension member.
 *
 * `options.force` defaults to TRUE — "regardless of expiry" is the contract
 * this function's name promises, and the sidecar calls it precisely because it
 * just saw a 401 from the provider, so remaining lifetime is not evidence the
 * token works. The freshness short-circuit in (2) is therefore skipped unless
 * a caller that is merely PROACTIVE opts in ({@link resolveOAuthTokenForSidecar}
 * does). The re-read itself always runs: `doRefresh` reloads the credential
 * state under the lock, so a peer's just-rotated `refresh_token` is what gets
 * spent either way.
 */
export async function forceRefreshOAuthModelProviderToken(
  credentialId: string,
  expectedOrgId?: string,
  options: { force?: boolean } = {},
): Promise<OAuthToken> {
  // Two dedup layers (in-process singleflight + cross-process Redis lock +
  // post-acquire re-read), owned by `dedupedRefresh`. The lock-winner may have
  // written a fresh token while we were waiting — the re-read short-circuit
  // returns it without burning the (potentially just-rotated) refresh_token.
  return dedupedRefresh<OAuthToken>(credentialId, {
    lockKey: `oauth-refresh:${credentialId}`,
    lockLabel: "oauth-refresh",
    force: options.force ?? true,
    reReadFreshness: async ({ force }) => {
      const state = await loadCredentialState(credentialId, expectedOrgId);
      if (state.blob.needsReconnection) {
        throw needsReconnection(credentialId, "connection_flagged");
      }
      // Forced: the caller has upstream evidence this token is dead, so an
      // unexpired `expiresAt` must not send it back down to the sidecar.
      if (force) return null;
      if (state.blob.expiresAt && state.blob.expiresAt - Date.now() > OAUTH_REFRESH_LEAD_MS) {
        return buildResolvedToken(state);
      }
      return null;
    },
    doRefresh: () => doRefresh(credentialId, expectedOrgId),
  });
}

async function doRefresh(credentialId: string, expectedOrgId?: string): Promise<OAuthToken> {
  const state = await loadCredentialState(credentialId, expectedOrgId);
  if (state.blob.needsReconnection) {
    throw needsReconnection(credentialId, "connection_flagged");
  }
  if (!state.blob.refreshToken) {
    await markCredentialNeedsReconnection(state.orgId, credentialId);
    throw needsReconnection(credentialId, "refresh_token_missing");
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
    if (!(err instanceof RefreshError)) throw err;
    switch (err.kind) {
      case "revoked":
        await markCredentialNeedsReconnection(state.orgId, credentialId);
        throw needsReconnection(credentialId, "refresh_token_revoked");
      case "client_rejected":
        // A broken client registration: a reconnect cannot fix it, so it is never counted.
        logger.error("oauth model provider: token endpoint rejected the OAuth client", {
          credentialId,
          providerId: state.config.providerId,
          error: err.message,
        });
        throw notRefreshed(credentialId, "oauth_client_rejected", err);
      case "transient": {
        // Not terminal — the cached token may still be valid. The streak escalates to
        // needsReconnection only past the threshold on a token expired past the grace window: the
        // same platform-wide policy as integrations (#596).
        const env = getEnv();
        await recordModelCredentialRefreshFailure(
          state.orgId,
          credentialId,
          env.INTEGRATION_REFRESH_MAX_FAILURES,
          env.INTEGRATION_REFRESH_GRACE_SECONDS,
        );
        throw notRefreshed(credentialId, "upstream_transient", err);
      }
    }
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

  return pickOAuthToken({
    accessToken: parsed.accessToken,
    expiresAt: expiresAtMs,
    accountId,
  });
}
