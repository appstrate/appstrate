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

import { eq } from "drizzle-orm";
import { integrationConnections } from "@appstrate/db/schema";
import { db } from "@appstrate/db/client";
import {
  RefreshError,
  parseTokenErrorResponse,
  parseTokenResponse,
  buildTokenHeaders,
  buildTokenBody,
  encryptCredentials,
  decryptCredentialsToStringMap,
} from "@appstrate/connect";
import type { RefreshContext as IntegrationRefreshContext } from "@appstrate/connect";

export type { IntegrationRefreshContext };

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

  const useBasicAuth = ctx.tokenAuthMethod === "client_secret_basic";
  const bodyParams: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    ...(useBasicAuth ? {} : { client_id: ctx.clientId, client_secret: ctx.clientSecret }),
  };
  const body = buildTokenBody(bodyParams, ctx.tokenContentType);

  let response: Response;
  try {
    response = await fetch(ctx.tokenUrl, {
      method: "POST",
      headers: buildTokenHeaders(
        ctx.tokenAuthMethod,
        ctx.clientId,
        ctx.clientSecret,
        ctx.tokenContentType,
      ),
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new RefreshError(
      `Integration token refresh network error for '${packageId}' auth '${authKey}': ${(err as Error).message}`,
      "transient",
    );
  }

  if (!response.ok) {
    const text = await response.text();
    const classification = parseTokenErrorResponse(response.status, text);
    if (classification.kind === "revoked") {
      // Flip needsReconnection so the dashboard prompts the user to re-connect.
      // Transient errors are NOT flagged — they may be temporary upstream issues.
      await db
        .update(integrationConnections)
        .set({ needsReconnection: true, updatedAt: new Date() })
        .where(eq(integrationConnections.id, connectionId));
    }
    const summary =
      classification.error !== undefined
        ? `${classification.error}${classification.errorDescription ? ` — ${classification.errorDescription}` : ""}`
        : `HTTP ${response.status}`;
    throw new RefreshError(
      `Integration token refresh failed for '${packageId}' auth '${authKey}': ${summary}`,
      classification.kind,
      response.status,
      text,
    );
  }

  let tokenData: Record<string, unknown>;
  try {
    tokenData = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new RefreshError(
      `Integration token refresh returned non-JSON response for '${packageId}' auth '${authKey}'`,
      "transient",
    );
  }

  const parsed = parseTokenResponse(
    {
      ...tokenData,
      access_token: tokenData.access_token ?? current.access_token ?? current.accessToken,
    },
    undefined,
    refreshToken,
  );

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
