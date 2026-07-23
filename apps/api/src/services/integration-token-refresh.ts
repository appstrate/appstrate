// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.5 — OAuth refresh for `integration_connections` rows.
 *
 * Reuses the OAuth2 refresh contract from `@appstrate/connect/token-refresh`
 * (in-memory dedup, the `revoked` vs `transient` RefreshError taxonomy,
 * write-on-success + clear-needsReconnection) but writes back to the
 * `integration_connections` table.
 *
 * Lives in apps/api rather than packages/connect because `integration_connections`
 * is platform-internal (the connect package intentionally stays free of
 * `@appstrate/db` to keep its surface light enough for the sidecar to
 * consume).
 */

import { eq } from "drizzle-orm";
import { integrationConnections } from "@appstrate/db/schema";
import { db } from "@appstrate/db/client";
import {
  RefreshError,
  performRefreshTokenExchange,
  decryptCredentialsToStringMap,
  resolveOAuthEndpoints,
} from "@appstrate/connect";
import type {
  RefreshContext as IntegrationRefreshContext,
  RefreshExchangeResult,
} from "@appstrate/connect";
import type { AfpsManifestAuth } from "./integration-manifest-helpers.ts";
import { logger } from "../lib/logger.ts";
import { dedupedRefresh } from "../lib/deduped-refresh.ts";
import { OAUTH_REFRESH_LEAD_MS } from "@appstrate/core/sidecar-types";
import {
  persistCredentialBundle,
  markIntegrationConnectionNeedsReconnection,
  recordIntegrationRefreshFailure,
  resolveIntegrationClientById,
} from "./integration-connections.ts";
import { getEnv } from "@appstrate/env";

export type { IntegrationRefreshContext };

export interface IntegrationRefreshResult {
  /** Decrypted credentials — snake_case wire keys only (`projectToStringMap`). */
  fields: Record<string, string>;
  /** Parsed `expires_at` from the token response, or `null` if upstream did not return `expires_in`. */
  expiresAt: Date | null;
  /**
   * Niveau 2 Phase 6 — scope set the IdP authoritatively granted on this
   * refresh (parsed from the response's `scope` field). `null` when the
   * response omitted `scope` entirely — per OAuth 2 §5.1 that means
   * "same scopes as previously issued", so the caller MUST NOT treat
   * `null` as "no scopes granted".
   */
  scopesGranted: string[] | null;
  /**
   * `true` when {@link scopesGranted} is non-null AND strictly narrower
   * than the connection's previously-stored `scopesGranted`. The IdP
   * has shrunk the grant — caller should re-check installed agents'
   * required scopes and flip `needsReconnection` if the shrink dropped
   * the actor below the minimum required set.
   *
   * `false` when scopes stayed the same, grew (creep), or the response
   * omitted `scope`. Callers can fast-path: ignore the cross-check
   * unless `shrinkDetected === true`.
   */
  shrinkDetected: boolean;
}

/**
 * Force-refresh the OAuth2 access token for an integration connection.
 * No-op (returns current creds) when the manifest auth isn't OAuth2 or no
 * per-app OAuth client is registered (`refreshContext` absent). When the auth
 * IS refreshable but the stored credentials carry no refresh_token, the token
 * is unrecoverable: returns the current creds AND flags needsReconnection so
 * the surface prompts a re-connect.
 *
 * On success: writes the new ciphertext + expiresAt + clears needsReconnection.
 * On `invalid_grant`: throws RefreshError(kind="revoked") AND flips
 * needsReconnection=true on the row (so the dashboard shows the re-connect
 * prompt at the next visit).
 * On any other failure: throws RefreshError(kind="transient") without
 * touching the row — caller fails the current request but the connection
 * stays usable for future calls.
 */
export async function forceRefreshIntegrationConnection(
  connectionId: string,
  packageIdForLog: string,
  authKeyForLog: string,
  credentialsEncrypted: string,
  refreshContext?: IntegrationRefreshContext,
): Promise<IntegrationRefreshResult> {
  if (!refreshContext) {
    return {
      fields: decryptCredentialsToStringMap(credentialsEncrypted),
      expiresAt: null,
      scopesGranted: null,
      shrinkDetected: false,
    };
  }

  // Two dedup layers (in-process singleflight + cross-process Redis lock +
  // post-acquire re-read), owned by `dedupedRefresh`. The re-read short-circuit
  // returns the stored creds when a peer instance already refreshed; otherwise
  // we refresh against the freshest stored ciphertext (a peer may have rotated
  // the refresh_token even if the access token is near expiry).
  let freshCiphertext = credentialsEncrypted;
  return dedupedRefresh<IntegrationRefreshResult>(connectionId, {
    lockKey: `intg-refresh:${connectionId}`,
    lockLabel: "intg-refresh",
    reReadFreshness: async () => {
      const [row] = await db
        .select({
          credentialsEncrypted: integrationConnections.credentialsEncrypted,
          expiresAt: integrationConnections.expiresAt,
        })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, connectionId))
        .limit(1);
      if (row?.credentialsEncrypted) freshCiphertext = row.credentialsEncrypted;
      if (row?.expiresAt && row.expiresAt.getTime() - Date.now() > OAUTH_REFRESH_LEAD_MS) {
        return {
          fields: decryptCredentialsToStringMap(row.credentialsEncrypted),
          expiresAt: row.expiresAt,
          scopesGranted: null,
          shrinkDetected: false,
        };
      }
      return null;
    },
    doRefresh: () =>
      doRefresh(connectionId, packageIdForLog, authKeyForLog, freshCiphertext, refreshContext),
  });
}

async function doRefresh(
  connectionId: string,
  packageId: string,
  authKey: string,
  credentialsEncrypted: string,
  ctx: IntegrationRefreshContext,
): Promise<IntegrationRefreshResult> {
  const current = decryptCredentialsToStringMap(credentialsEncrypted);
  const refreshToken = current.refresh_token;
  if (!refreshToken) {
    // We only reach `doRefresh` when a refresh was actually warranted — the
    // caller is either inside the proactive lead window (token expiring) or
    // recovering from an upstream 401. With no refresh_token there is no way
    // to recover: the access token is or will be dead. Flag the connection so
    // the agent/dashboard surfaces a re-connect prompt instead of silently
    // serving a token that 401s on every call. (Root cause for Google was a
    // missing `access_type=offline` on the authorize URL — see
    // `auths.{key}.authorizationParams` — so the IdP never issued one.)
    logger.warn(
      "Integration connection unrefreshable — no refresh_token; flagging needsReconnection",
      {
        packageId,
        authKey,
        connectionId,
      },
    );
    await markIntegrationConnectionNeedsReconnection(connectionId);
    return { fields: current, expiresAt: null, scopesGranted: null, shrinkDetected: false };
  }

  let parsed: RefreshExchangeResult["parsed"];
  let tokenData: Record<string, unknown>;
  try {
    ({ parsed, raw: tokenData } = await performRefreshTokenExchange(ctx, refreshToken, {
      label: `Integration token refresh for '${packageId}' auth '${authKey}'`,
      accessTokenFallback: current.access_token,
    }));
  } catch (err) {
    // Flip needsReconnection on a revoked refresh token so the dashboard
    // prompts re-connect. The wire mechanics + classification live in the
    // shared exchange; only the table write-back is integration-side.
    if (err instanceof RefreshError && err.kind === "revoked") {
      await markIntegrationConnectionNeedsReconnection(connectionId);
    } else {
      // Transient failure (network / 5xx / parse). A single transient error is
      // NOT terminal — the cached token may still be valid. But a token that is
      // already expired AND keeps failing refresh is silently dead while the
      // row still looks healthy (the original Gmail scheduled-run bug). Record
      // the failure; `recordIntegrationRefreshFailure` escalates to
      // needsReconnection only once the streak crosses the threshold AND the
      // token is expired past the grace window, so a transient upstream blip on
      // a still-valid token never bricks the connection.
      const env = getEnv();
      await recordIntegrationRefreshFailure(
        connectionId,
        env.INTEGRATION_REFRESH_MAX_FAILURES,
        env.INTEGRATION_REFRESH_GRACE_SECONDS,
      );
    }
    throw err;
  }

  // `parseTokenResponse` may return `undefined` for refreshToken on flows
  // that don't rotate it — preserve whatever the current ciphertext held in
  // that case so the next refresh still works.
  const finalRefreshToken = parsed.refreshToken ?? refreshToken;
  const newCreds: Record<string, string> = {
    access_token: parsed.accessToken,
    refresh_token: finalRefreshToken,
  };
  const expiresAt = parsed.expiresAt ? new Date(parsed.expiresAt) : null;

  // Niveau 2 Phase 6 — only treat the response's `scope` as authoritative
  // when the IdP echoed it explicitly. `parseTokenResponse` falls back to
  // the requestedScopes (here `undefined` → `[]`) when the response omits
  // `scope`; an empty array under that path would FALSELY signal a total
  // revocation. Distinguish by checking the raw wire payload directly.
  const responseHadScopeField = typeof tokenData.scope === "string" && tokenData.scope.length > 0;
  const responseScopes = responseHadScopeField ? parsed.scopesGranted : null;

  // Read the existing `scopes_granted` so we can detect shrinkage. One
  // extra SELECT per refresh is acceptable — refresh is the slow path.
  const [prevRow] = await db
    .select({ scopesGranted: integrationConnections.scopesGranted })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
    .limit(1);
  const prevScopes = prevRow?.scopesGranted ?? [];
  const shrinkDetected =
    responseScopes !== null && responseScopes.length > 0
      ? prevScopes.some((s) => !responseScopes.includes(s))
      : false;

  // Converged write — the single credential writer. `scopesGranted` is passed
  // only when the IdP authoritatively echoed a `scope` field; otherwise it is
  // omitted so persistCredentialBundle leaves the high-water-mark untouched.
  // accountId/identityClaims are likewise omitted → never clobbered by refresh.
  await persistCredentialBundle(
    { kind: "update-by-id", connectionId },
    {
      credentials: newCreds,
      expiresAt,
      needsReconnection: false,
      ...(responseScopes !== null ? { scopesGranted: responseScopes } : {}),
    },
  );

  return { fields: newCreds, expiresAt, scopesGranted: responseScopes, shrinkDetected };
}

/**
 * Discriminated outcome of {@link refreshAndClassify}. Wraps the
 * {@link forceRefreshIntegrationConnection} call + the
 * `RefreshError && kind==="revoked"` classification that both integration
 * credential resolvers share, so each can map the outcome to its own
 * transport surface (the MITM resolver → 410/502 ApiError; the
 * credential-proxy resolver → IntegrationCredentialRevokedError / null)
 * without duplicating the try/catch taxonomy.
 *
 * - `refreshed`: the refresh succeeded; `result` carries the new fields,
 *   expiresAt, and scope-shrink signals.
 * - `revoked`: the refresh token was revoked upstream (RFC 6749 §5.2
 *   `invalid_grant`); the helper has already flipped `needsReconnection`.
 * - `transient`: any other failure (network, 5xx, parse). The cached
 *   credential may still be usable; the connection row is untouched.
 */
export type RefreshClassification =
  | { status: "refreshed"; result: IntegrationRefreshResult }
  | { status: "revoked"; error: RefreshError }
  | { status: "transient"; error: unknown };

/**
 * Run {@link forceRefreshIntegrationConnection} and classify the outcome into
 * the {@link RefreshClassification} discriminated union. Never throws — the
 * caller maps each branch to its own transport error. Shared by the MITM
 * credentials resolver and the credential-proxy resolver.
 */
export async function refreshAndClassify(
  connectionId: string,
  packageIdForLog: string,
  authKeyForLog: string,
  credentialsEncrypted: string,
  refreshContext: IntegrationRefreshContext,
): Promise<RefreshClassification> {
  try {
    const result = await forceRefreshIntegrationConnection(
      connectionId,
      packageIdForLog,
      authKeyForLog,
      credentialsEncrypted,
      refreshContext,
    );
    return { status: "refreshed", result };
  } catch (err) {
    if (err instanceof RefreshError && err.kind === "revoked") {
      return { status: "revoked", error: err };
    }
    return { status: "transient", error: err };
  }
}

/**
 * Decrypt an integration connection's credential blob into a flat string
 * map, returning `null` (with a warning) on failure rather than throwing.
 * Shared by the MITM credentials resolver and the credential-proxy resolver.
 */
export function decryptIntegrationConnectionFields(
  ciphertext: string,
  packageIdForLog: string,
  authKeyForLog: string,
): Record<string, string> | null {
  try {
    return decryptCredentialsToStringMap(ciphertext);
  } catch (err) {
    logger.warn("integration credential decrypt failed", {
      packageId: packageIdForLog,
      authKey: authKeyForLog,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Build the OAuth2 {@link IntegrationRefreshContext} for an integration
 * auth from its per-application `integration_oauth_clients` row. Returns
 * `null` (the auth is not refreshable) for: non-oauth2 auths, auths without a
 * `tokenUrl`, missing per-app OAuth client, and undecryptable client secret.
 *
 * Public clients (`token_endpoint_auth_method: "none"`, RFC 7591 §2) ARE
 * supported — the refresh helper sends `client_id` in the body with no
 * `client_secret` (RFC 6749 §6 + §3.2.1). Single source of truth shared by
 * both integration credential resolvers.
 */
export async function buildIntegrationOAuthRefreshContext(
  packageId: string,
  authKey: string,
  authDef: AfpsManifestAuth,
  applicationId: string,
  /**
   * The minting client pinned on the connection
   * (`integration_connections.client_ref`): a flat client id — the env id of a
   * system client or the `integration_oauth_clients.id` of a custom client.
   * Resolves WHICH client's credentials refresh the tokens — the same one that
   * minted them. `null` only for non-oauth2 connections, which never reach this
   * function (guarded below).
   */
  clientRef: string | null,
): Promise<IntegrationRefreshContext | null> {
  if (authDef.type !== "oauth2") return null;
  // AFPS §7.3: refresh POSTs to `token_endpoint`. When the manifest declares
  // only an `issuer` (Drive/OneDrive and other issuer-only providers), resolve
  // the endpoint with the SAME OIDC/RFC-8414 discovery the authorize flow uses
  // (`resolveOAuthEndpoints`, cached per-issuer). Without this, issuer-only
  // connections connect fine but can NEVER refresh — they die when the access
  // token expires (~1h) and the user is stuck re-connecting hourly.
  const afpsAuth = authDef;
  const { tokenEndpoint } = await resolveOAuthEndpoints({
    issuer: afpsAuth.issuer,
    tokenEndpoint: afpsAuth.token_endpoint,
  });
  if (!tokenEndpoint) {
    // An `issuer`-only manifest (Drive/OneDrive …) whose discovery yielded no
    // `token_endpoint` is NOT terminal — discovery is best-effort and a routine
    // IdP/network blip would otherwise brick refresh and falsely flag the
    // connection `needsReconnection`. Surface it as TRANSIENT so the caller
    // keeps the cached credential and retries later (resolveOAuthEndpoints no
    // longer negatively-caches, so the next attempt re-discovers). Only a
    // manifest with neither `issuer` NOR `token_endpoint` is genuinely
    // unrefreshable (terminal → null).
    if (afpsAuth.issuer) {
      throw new RefreshError(
        `Integration '${packageId}' auth '${authKey}' token_endpoint discovery yielded none (transient)`,
        "transient",
      );
    }
    logger.info("Integration auth refresh skipped — no token_endpoint and no issuer", {
      packageId,
      authKey,
    });
    return null;
  }
  const tokenEndpointAuthMethod = afpsAuth.token_endpoint_auth_method;

  // INVARIANT: an oauth2 connection always pins its minting client. A null here
  // means a non-oauth2 row reached this oauth2-only path — a bug, not a state to
  // tolerate. Skip safely (surfaces needs_reconnection at expiry) rather than
  // guessing a client.
  if (clientRef === null) {
    logger.warn("Integration oauth2 connection has no client_ref — skipping refresh", {
      packageId,
      authKey,
    });
    return null;
  }

  // Resolve the SAME client that minted the connection by its pinned id (system
  // env or per-application custom row), with the cross-scope escalation guard.
  // Null → since-removed / remapped / cross-scope id: skip (needs_reconnection).
  const client = await resolveIntegrationClientById(
    clientRef,
    applicationId,
    packageId,
    authKey,
    tokenEndpointAuthMethod,
  );
  if (!client) {
    logger.info("Integration auth refresh skipped — pinned client unresolved", {
      packageId,
      authKey,
      clientRef,
    });
    return null;
  }
  const { clientId, clientSecret } = client;
  // AFPS: `scope_separator` moved under `_meta["dev.appstrate/oauth"]`.
  const oauthMeta = (afpsAuth._meta?.["dev.appstrate/oauth"] ?? undefined) as
    { scope_separator?: string } | undefined;
  return {
    tokenEndpoint,
    clientId,
    clientSecret,
    ...(tokenEndpointAuthMethod ? { tokenEndpointAuthMethod } : {}),
    ...(oauthMeta?.scope_separator ? { scopeSeparator: oauthMeta.scope_separator } : {}),
  };
}
