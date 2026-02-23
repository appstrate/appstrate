import { eq } from "drizzle-orm";
import { serviceConnections } from "@appstrate/db/schema";
import type { Db } from "@appstrate/db/client";
import type { DecryptedCredentials } from "./types.ts";
import { getProviderOrThrow, getProviderOAuthCredentialsOrThrow } from "./registry.ts";
import { encryptCredentials, decryptCredentials } from "./encryption.ts";
import { parseTokenResponse } from "./token-utils.ts";
import { extractErrorMessage } from "./utils.ts";

/** In-memory concurrency lock: one refresh at a time per connection. */
const inflightRefreshes = new Map<string, Promise<DecryptedCredentials>>();

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry

/**
 * Refresh an OAuth2 token if it's about to expire.
 * Returns the (possibly refreshed) decrypted credentials.
 *
 * Handles concurrency: if a refresh is already in progress for this connection,
 * subsequent callers wait for the same promise.
 */
export async function refreshIfNeeded(
  db: Db,
  orgId: string,
  connectionId: string,
  providerId: string,
  credentialsEncrypted: string,
  expiresAt: string | null,
): Promise<DecryptedCredentials> {
  // If not expired (or no expiry set), return current credentials
  if (!expiresAt) {
    return decryptCredentials<DecryptedCredentials>(credentialsEncrypted);
  }
  const expiresMs = new Date(expiresAt).getTime();
  if (!Number.isNaN(expiresMs) && expiresMs > Date.now() + REFRESH_BUFFER_MS) {
    return decryptCredentials<DecryptedCredentials>(credentialsEncrypted);
  }

  // Check for in-flight refresh
  const inflight = inflightRefreshes.get(connectionId);
  if (inflight) return inflight;

  // Start refresh
  const refreshPromise = doRefresh(db, orgId, connectionId, providerId, credentialsEncrypted);

  inflightRefreshes.set(connectionId, refreshPromise);

  try {
    return await refreshPromise;
  } finally {
    inflightRefreshes.delete(connectionId);
  }
}

async function doRefresh(
  db: Db,
  orgId: string,
  connectionId: string,
  providerId: string,
  credentialsEncrypted: string,
): Promise<DecryptedCredentials> {
  const creds = decryptCredentials<DecryptedCredentials>(credentialsEncrypted);

  if (!creds.refresh_token) {
    return creds;
  }

  const provider = await getProviderOrThrow(db, orgId, providerId);
  const tokenUrl = provider.refreshUrl ?? provider.tokenUrl;
  if (!tokenUrl) {
    throw new Error(`Provider '${providerId}' has no token URL for refresh`);
  }

  const oauthCreds = await getProviderOAuthCredentialsOrThrow(db, orgId, providerId);

  // Perform token refresh
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: creds.refresh_token,
    client_id: oauthCreds.clientId,
    client_secret: oauthCreds.clientSecret,
  });

  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
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
    " ",
    undefined,
    creds.refresh_token,
  );

  const newCreds: DecryptedCredentials = {
    access_token: parsed.accessToken,
    refresh_token: parsed.refreshToken,
  };
  const newExpiresAt = parsed.expiresAt;

  // Update the connection in DB
  const newEncrypted = encryptCredentials(newCreds);
  try {
    await db
      .update(serviceConnections)
      .set({
        credentialsEncrypted: newEncrypted,
        expiresAt: newExpiresAt ? new Date(newExpiresAt) : null,
        updatedAt: new Date(),
      })
      .where(eq(serviceConnections.id, connectionId));
  } catch (updateError) {
    console.error(`Failed to persist refreshed token for connection ${connectionId}:`, updateError);
  }

  return newCreds;
}
