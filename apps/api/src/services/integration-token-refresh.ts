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
 * consume). The two helpers should ideally be consolidated behind a
 * table-agnostic writer callback — left as a follow-up.
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
  decryptCredentials,
} from "@appstrate/connect";
import type { OAuthTokenAuthMethod, OAuthTokenContentType } from "@appstrate/core/validation";

/** Same shape as `RefreshContext` in `@appstrate/connect/token-refresh`. */
export interface IntegrationRefreshContext {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  tokenAuthMethod?: OAuthTokenAuthMethod;
  scopeSeparator?: string;
  tokenContentType?: OAuthTokenContentType;
}

/** Per-connection in-flight lock — coalesces concurrent refresh calls. */
const inflightRefreshes = new Map<string, Promise<Record<string, string>>>();

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
): Promise<Record<string, string>> {
  if (!refreshContext) {
    return decryptCredentialsAsStringMap(credentialsEncrypted);
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
): Promise<Record<string, string>> {
  const current = decryptCredentialsAsStringMap(credentialsEncrypted);
  // The OAuth callback stores tokens under snake_case (refresh_token) AND
  // camelCase (refreshToken) depending on how the storage path was reached.
  // Read both.
  const refreshToken = current.refresh_token ?? current.refreshToken;
  if (!refreshToken) {
    return current;
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
  await db
    .update(integrationConnections)
    .set({
      credentialsEncrypted: encryptCredentials(newCreds),
      expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
      needsReconnection: false,
      updatedAt: new Date(),
    })
    .where(eq(integrationConnections.id, connectionId));

  return newCreds;
}

function decryptCredentialsAsStringMap(ciphertext: string): Record<string, string> {
  const raw = decryptCredentials<Record<string, unknown>>(ciphertext) ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
