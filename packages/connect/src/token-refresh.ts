import { eq } from "drizzle-orm";
import { serviceConnections } from "@appstrate/db/schema";
import type { Db } from "@appstrate/db/client";
import type { DecryptedCredentials, ProviderSnapshot } from "./types.ts";
import { encryptCredentials, decryptCredentials, decrypt } from "./encryption.ts";
import { parseTokenResponse, buildTokenHeaders } from "./token-utils.ts";
import { extractErrorMessage } from "./utils.ts";

/** In-memory concurrency lock: one refresh at a time per connection. */
const inflightRefreshes = new Map<string, Promise<DecryptedCredentials>>();

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry

/**
 * Refresh an OAuth2 token if it's about to expire.
 * Returns the (possibly refreshed) decrypted credentials.
 * Uses providerSnapshot for all OAuth config (tokenUrl, clientId/Secret).
 */
export async function refreshIfNeeded(
  db: Db,
  connectionId: string,
  providerId: string,
  credentialsEncrypted: string,
  expiresAt: string | null,
  providerSnapshot: ProviderSnapshot,
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
  const refreshPromise = doRefresh(
    db,
    connectionId,
    providerId,
    credentialsEncrypted,
    providerSnapshot,
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
  providerSnapshot: ProviderSnapshot,
): Promise<DecryptedCredentials> {
  const creds = decryptCredentials<DecryptedCredentials>(credentialsEncrypted);

  if (!creds.refresh_token) {
    return creds;
  }

  const tokenUrl = providerSnapshot.refreshUrl ?? providerSnapshot.tokenUrl;
  if (!tokenUrl) {
    throw new Error(`Provider '${providerId}' has no token URL for refresh (from snapshot)`);
  }

  // Decrypt clientId/Secret from the snapshot
  if (!providerSnapshot.clientIdEncrypted || !providerSnapshot.clientSecretEncrypted) {
    throw new Error(`Provider '${providerId}' has no OAuth credentials in snapshot`);
  }
  const clientId = decrypt(providerSnapshot.clientIdEncrypted);
  const clientSecret = decrypt(providerSnapshot.clientSecretEncrypted);

  // Perform token refresh
  const useBasicAuth = providerSnapshot.tokenAuthMethod === "client_secret_basic";

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: creds.refresh_token,
    ...(useBasicAuth ? {} : { client_id: clientId, client_secret: clientSecret }),
  });

  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: buildTokenHeaders(providerSnapshot.tokenAuthMethod, clientId, clientSecret),
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
    providerSnapshot.scopeSeparator ?? " ",
    undefined,
    creds.refresh_token,
  );

  const newCreds: DecryptedCredentials = {
    access_token: parsed.accessToken,
    refresh_token: parsed.refreshToken,
  };
  const newExpiresAt = parsed.expiresAt;

  // Update the connection in DB — propagate error so callers can log appropriately
  const newEncrypted = encryptCredentials(newCreds);
  await db
    .update(serviceConnections)
    .set({
      credentialsEncrypted: newEncrypted,
      expiresAt: newExpiresAt ? new Date(newExpiresAt) : null,
      updatedAt: new Date(),
    })
    .where(eq(serviceConnections.id, connectionId));

  return newCreds;
}
