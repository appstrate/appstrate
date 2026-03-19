import { eq } from "drizzle-orm";
import { userProviderConnections } from "@appstrate/db/schema";
import type { Db } from "@appstrate/db/client";
import type { DecryptedCredentials } from "./types.ts";
import { encryptCredentials, decryptCredentials } from "./encryption.ts";
import { parseTokenResponse, buildTokenHeaders } from "./token-utils.ts";
import { extractErrorMessage } from "./utils.ts";

/** In-memory concurrency lock: one refresh at a time per connection. */
const inflightRefreshes = new Map<string, Promise<DecryptedCredentials>>();

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry

export interface RefreshContext {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  tokenAuthMethod?: string;
  scopeSeparator?: string;
}

/**
 * Refresh an OAuth2 token if it's about to expire.
 * Returns the (possibly refreshed) decrypted credentials.
 * Requires a RefreshContext with OAuth config (tokenUrl, clientId/Secret).
 * If refreshContext is not provided, refresh is skipped.
 */
export async function refreshIfNeeded(
  db: Db,
  connectionId: string,
  providerId: string,
  credentialsEncrypted: string,
  expiresAt: string | null,
  refreshContext?: RefreshContext,
): Promise<DecryptedCredentials> {
  // If not expired (or no expiry set), return current credentials
  if (!expiresAt) {
    return decryptCredentials<DecryptedCredentials>(credentialsEncrypted);
  }
  const expiresMs = new Date(expiresAt).getTime();
  if (!Number.isNaN(expiresMs) && expiresMs > Date.now() + REFRESH_BUFFER_MS) {
    return decryptCredentials<DecryptedCredentials>(credentialsEncrypted);
  }

  // If no refresh context available, return current credentials (can't refresh)
  if (!refreshContext) {
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

  // Perform token refresh
  const useBasicAuth = ctx.tokenAuthMethod === "client_secret_basic";

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: creds.refresh_token,
    ...(useBasicAuth ? {} : { client_id: ctx.clientId, client_secret: ctx.clientSecret }),
  });

  let response: Response;
  try {
    response = await fetch(ctx.tokenUrl, {
      method: "POST",
      headers: buildTokenHeaders(ctx.tokenAuthMethod, ctx.clientId, ctx.clientSecret),
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
    ctx.scopeSeparator ?? " ",
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
    .update(userProviderConnections)
    .set({
      credentialsEncrypted: newEncrypted,
      expiresAt: newExpiresAt ? new Date(newExpiresAt) : null,
      updatedAt: new Date(),
    })
    .where(eq(userProviderConnections.id, connectionId));

  return newCreds;
}
