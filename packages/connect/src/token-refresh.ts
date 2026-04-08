// SPDX-License-Identifier: Apache-2.0

import { eq } from "drizzle-orm";
import { userProviderConnections } from "@appstrate/db/schema";
import type { Db } from "@appstrate/db/client";
import type { DecryptedCredentials } from "./types.ts";
import { encryptCredentials, decryptCredentials } from "./encryption.ts";
import {
  parseTokenResponse,
  buildTokenHeaders,
  buildTokenBody,
  type OAuthTokenAuthMethod,
  type OAuthTokenContentType,
} from "./token-utils.ts";
import { extractErrorMessage } from "./utils.ts";

/** In-memory concurrency lock: one refresh at a time per connection. */
const inflightRefreshes = new Map<string, Promise<DecryptedCredentials>>();

export interface RefreshContext {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  tokenAuthMethod?: OAuthTokenAuthMethod;
  scopeSeparator?: string;
  tokenContentType?: OAuthTokenContentType;
}

/**
 * Force a token refresh regardless of expiry.
 * Returns refreshed credentials, or current credentials if no refresh token / not OAuth2.
 * Throws if the refresh request itself fails (invalid_grant, network error).
 * Clears `needsReconnection` on success — a successful refresh proves the connection is healthy.
 */
export async function forceRefresh(
  db: Db,
  connectionId: string,
  providerId: string,
  credentialsEncrypted: string,
  refreshContext?: RefreshContext,
): Promise<DecryptedCredentials> {
  if (!refreshContext) {
    return decryptCredentials<DecryptedCredentials>(credentialsEncrypted);
  }

  // Deduplicate concurrent refreshes for the same connection
  const inflight = inflightRefreshes.get(connectionId);
  if (inflight) return inflight;

  const refreshPromise = doRefresh(
    db,
    connectionId,
    providerId,
    credentialsEncrypted,
    refreshContext,
  );
  inflightRefreshes.set(connectionId, refreshPromise);

  try {
    return await refreshPromise;
  } finally {
    inflightRefreshes.delete(connectionId);
  }
}

async function doRefresh(
  db: Db,
  connectionId: string,
  providerId: string,
  credentialsEncrypted: string,
  ctx: RefreshContext,
): Promise<DecryptedCredentials> {
  const creds = decryptCredentials<DecryptedCredentials>(credentialsEncrypted);

  if (!creds.refresh_token) {
    return creds;
  }

  const useBasicAuth = ctx.tokenAuthMethod === "client_secret_basic";

  const bodyParams: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: creds.refresh_token,
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
    throw new Error(`Token refresh network error for '${providerId}': ${extractErrorMessage(err)}`);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed for '${providerId}': ${response.status} ${text}`);
  }

  let tokenData: Record<string, unknown>;
  try {
    tokenData = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`Token refresh returned non-JSON response for '${providerId}'`);
  }

  const parsed = parseTokenResponse(
    { ...tokenData, access_token: tokenData.access_token ?? creds.access_token },
    undefined,
    creds.refresh_token,
  );

  const newCreds: DecryptedCredentials = {
    access_token: parsed.accessToken,
    refresh_token: parsed.refreshToken,
  };
  const newExpiresAt = parsed.expiresAt;

  const newEncrypted = encryptCredentials(newCreds);
  await db
    .update(userProviderConnections)
    .set({
      credentialsEncrypted: newEncrypted,
      expiresAt: newExpiresAt ? new Date(newExpiresAt) : null,
      needsReconnection: false,
      updatedAt: new Date(),
    })
    .where(eq(userProviderConnections.id, connectionId));

  return newCreds;
}
