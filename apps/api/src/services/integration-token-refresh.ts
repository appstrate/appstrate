// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.5 — OAuth refresh for `integration_connections` rows.
 *
 * Mirrors the contract of `forceRefresh` in `@appstrate/connect/token-refresh`
 * (which writes back to `user_provider_connections`) but targets the
 * integration-side table. Same in-memory dedup, same RefreshError taxonomy
 * (`revoked` vs `transient`), same write-on-success + clear-needsReconnection
 * semantics.
 *
 * Lives in apps/api rather than packages/connect because `integration_connections`
 * is platform-internal (the connect package intentionally stays free of
 * `@appstrate/db` to keep its surface light enough for the sidecar to
 * consume).
 */

import { and, eq } from "drizzle-orm";
import { integrationConnections, integrationOauthClients } from "@appstrate/db/schema";
import { db } from "@appstrate/db/client";
import {
  RefreshError,
  performRefreshTokenExchange,
  encryptCredentials,
  decryptCredentials,
  decryptCredentialsToStringMap,
} from "@appstrate/connect";
import type {
  RefreshContext as IntegrationRefreshContext,
  RefreshExchangeResult,
} from "@appstrate/connect";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { logger } from "../lib/logger.ts";

export type { IntegrationRefreshContext };

type IntegrationAuthDef = NonNullable<IntegrationManifest["auths"]>[string];

export interface IntegrationRefreshResult {
  /** Decrypted credentials (snake_case + camelCase aliases). */
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

/** Per-connection in-flight lock — coalesces concurrent refresh calls. */
const inflightRefreshes = new Map<string, Promise<IntegrationRefreshResult>>();

/**
 * Force-refresh the OAuth2 access token for an integration connection.
 * No-op (returns current creds) when the connection has no refresh_token
 * or the manifest auth isn't OAuth2.
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

  const cached = inflightRefreshes.get(connectionId);
  if (cached) return cached;

  const promise = doRefresh(
    connectionId,
    packageIdForLog,
    authKeyForLog,
    credentialsEncrypted,
    refreshContext,
  );
  inflightRefreshes.set(connectionId, promise);
  try {
    return await promise;
  } finally {
    inflightRefreshes.delete(connectionId);
  }
}

async function doRefresh(
  connectionId: string,
  packageId: string,
  authKey: string,
  credentialsEncrypted: string,
  ctx: IntegrationRefreshContext,
): Promise<IntegrationRefreshResult> {
  const current = decryptCredentialsToStringMap(credentialsEncrypted);
  // The OAuth callback stores tokens under snake_case (refresh_token) AND
  // camelCase (refreshToken) depending on how the storage path was reached.
  // Read both.
  const refreshToken = current.refresh_token ?? current.refreshToken;
  if (!refreshToken) {
    return { fields: current, expiresAt: null, scopesGranted: null, shrinkDetected: false };
  }

  let parsed: RefreshExchangeResult["parsed"];
  let tokenData: Record<string, unknown>;
  try {
    ({ parsed, raw: tokenData } = await performRefreshTokenExchange(ctx, refreshToken, {
      label: `Integration token refresh for '${packageId}' auth '${authKey}'`,
      accessTokenFallback: current.access_token ?? current.accessToken,
    }));
  } catch (err) {
    // Flip needsReconnection on a revoked refresh token so the dashboard
    // prompts re-connect. Transient errors are NOT flagged — they may be
    // temporary upstream issues. The wire mechanics + classification live
    // in the shared exchange; only the table write-back is integration-side.
    if (err instanceof RefreshError && err.kind === "revoked") {
      await db
        .update(integrationConnections)
        .set({ needsReconnection: true, updatedAt: new Date() })
        .where(eq(integrationConnections.id, connectionId));
    }
    throw err;
  }

  // Persist both snake_case AND camelCase aliases so downstream code paths
  // that read either spelling (e.g. delivery.env `from: "accessToken"`) keep
  // working without surprise. `parseTokenResponse` may return `undefined`
  // for refreshToken on flows that don't rotate it — preserve whatever the
  // current ciphertext held in that case so the next refresh still works.
  const finalRefreshToken = parsed.refreshToken ?? refreshToken;
  const newCreds: Record<string, string> = {
    access_token: parsed.accessToken,
    accessToken: parsed.accessToken,
    refresh_token: finalRefreshToken,
    refreshToken: finalRefreshToken,
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

  await db
    .update(integrationConnections)
    .set({
      credentialsEncrypted: encryptCredentials(newCreds),
      expiresAt,
      needsReconnection: false,
      updatedAt: new Date(),
      // Only overwrite scopesGranted when the IdP authoritatively echoed
      // a `scope` field. Otherwise leave the high-water-mark untouched.
      ...(responseScopes !== null ? { scopesGranted: responseScopes } : {}),
    })
    .where(eq(integrationConnections.id, connectionId));

  return { fields: newCreds, expiresAt, scopesGranted: responseScopes, shrinkDetected };
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
 * `null` (the auth is not refreshable) for: non-oauth2 auths, discovery-only
 * flows without a `tokenUrl`, missing per-app OAuth client, undecryptable
 * client secret, and public clients (`tokenAuthMethod: "none"`, not modelled
 * by the shared refresh helper). Single source of truth shared by both
 * integration credential resolvers.
 */
export async function buildIntegrationOAuthRefreshContext(
  packageId: string,
  authKey: string,
  authDef: IntegrationAuthDef,
  applicationId: string,
): Promise<IntegrationRefreshContext | null> {
  if (authDef.type !== "oauth2") return null;
  if (!authDef.tokenUrl) {
    // Discovery-only flows (`discovery: "auto"` or `discovery: {…}`) need
    // a one-shot RFC 9728 resolution before they can refresh. Not wired in
    // this first cut — the agent sees the stale token until the next spawn.
    logger.info("Integration auth refresh skipped — discovery-only flow", { packageId, authKey });
    return null;
  }
  const [client] = await db
    .select({
      clientId: integrationOauthClients.clientId,
      clientSecretEncrypted: integrationOauthClients.clientSecretEncrypted,
    })
    .from(integrationOauthClients)
    .where(
      and(
        eq(integrationOauthClients.applicationId, applicationId),
        eq(integrationOauthClients.integrationPackageId, packageId),
        eq(integrationOauthClients.authKey, authKey),
      ),
    )
    .limit(1);
  if (!client) {
    // The application admin never registered an OAuth client for this auth —
    // the connection was provisioned via DCR or a system-wide client. Cannot
    // refresh without those credentials; skip.
    logger.info("Integration auth refresh skipped — no per-app OAuth client", {
      packageId,
      authKey,
    });
    return null;
  }
  let clientSecret: string;
  try {
    const decrypted = decryptCredentials<{ client_secret?: string }>(client.clientSecretEncrypted);
    clientSecret = decrypted.client_secret ?? "";
  } catch (err) {
    logger.warn("Integration auth client_secret decrypt failed", {
      packageId,
      authKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  // `tokenAuthMethod: "none"` (public clients) needs `client_id` in the body
  // with NO `client_secret`. The shared refresh helper doesn't model that —
  // skip rather than send a malformed request the upstream would reject.
  if (authDef.tokenAuthMethod === "none") {
    logger.info("Integration auth refresh skipped — public client (tokenAuthMethod=none)", {
      packageId,
      authKey,
    });
    return null;
  }
  return {
    tokenUrl: authDef.tokenUrl,
    clientId: client.clientId,
    clientSecret,
    ...(authDef.tokenAuthMethod ? { tokenAuthMethod: authDef.tokenAuthMethod } : {}),
    ...(authDef.scopeSeparator ? { scopeSeparator: authDef.scopeSeparator } : {}),
  };
}
