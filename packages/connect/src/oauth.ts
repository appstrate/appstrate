import { randomBytes, createHash } from "node:crypto";
import { eq, and, gt } from "drizzle-orm";
import { oauthStates } from "@appstrate/db/schema";
import type { Db } from "@appstrate/db/client";
import type { OAuthStateRecord } from "./types.ts";
import { getProviderOrThrow, getProviderOAuthCredentialsOrThrow } from "./registry.ts";
import { parseTokenResponse, buildTokenHeaders } from "./token-utils.ts";
import { extractErrorMessage } from "./utils.ts";

/**
 * Generate a cryptographically random base64url string.
 */
function randomBase64Url(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

/**
 * Compute SHA-256 hash in base64url format (for PKCE code_challenge).
 */
function sha256Base64Url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

export interface InitiateOAuthResult {
  authUrl: string;
  state: string;
}

/**
 * Initiate an OAuth2 authorization flow.
 * Creates a PKCE challenge (if supported), stores state in DB, and returns the auth URL.
 * orgId is needed for provider config lookup during OAuth.
 * profileId is stored in oauth_states for the callback.
 */
export async function initiateOAuth(
  db: Db,
  orgId: string,
  userId: string,
  profileId: string,
  providerId: string,
  redirectUri: string,
  requestedScopes?: string[],
): Promise<InitiateOAuthResult> {
  const provider = await getProviderOrThrow(db, orgId, providerId, "oauth2");
  if (!provider.authorizationUrl) {
    throw new Error(`Provider '${providerId}' has no authorization URL configured`);
  }

  const oauthCreds = await getProviderOAuthCredentialsOrThrow(db, orgId, providerId);

  // Generate PKCE values
  const state = crypto.randomUUID();
  const codeVerifier = randomBase64Url(32);
  const codeChallenge = sha256Base64Url(codeVerifier);

  // Merge default + requested scopes
  const allScopes = [...(provider.defaultScopes ?? []), ...(requestedScopes ?? [])];
  const uniqueScopes = [...new Set(allScopes)];
  const scopeString = uniqueScopes.join(provider.scopeSeparator ?? " ");

  // Store OAuth state in DB
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await db.insert(oauthStates).values({
    state,
    orgId,
    userId,
    profileId,
    providerId,
    codeVerifier,
    scopesRequested: uniqueScopes,
    redirectUri,
    expiresAt,
  });

  // Build authorization URL
  const params = new URLSearchParams({
    client_id: oauthCreds.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    ...(scopeString ? { scope: scopeString } : {}),
    ...(provider.pkceEnabled !== false
      ? {
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        }
      : {}),
    ...(provider.authorizationParams ?? {}),
  });

  const authUrl = `${provider.authorizationUrl}?${params.toString()}`;

  return { authUrl, state };
}

export interface OAuthCallbackResult {
  providerId: string;
  orgId: string;
  userId: string;
  profileId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: string | null;
  scopesGranted: string[];
  rawResponse: Record<string, unknown>;
}

/**
 * Handle the OAuth2 callback.
 * Exchanges the authorization code for tokens using PKCE.
 * Returns profileId from the stored oauth state.
 */
export async function handleOAuthCallback(
  db: Db,
  code: string,
  state: string,
): Promise<OAuthCallbackResult> {
  // Look up the OAuth state
  const rows = await db
    .select()
    .from(oauthStates)
    .where(and(eq(oauthStates.state, state), gt(oauthStates.expiresAt, new Date())))
    .limit(1);

  if (rows.length === 0) {
    throw new Error("Invalid or expired OAuth state");
  }

  const rawRow = rows[0]!;

  // Map to OAuthStateRecord
  const stateRow: OAuthStateRecord = {
    state: rawRow.state,
    orgId: rawRow.orgId,
    userId: rawRow.userId,
    profileId: rawRow.profileId,
    providerId: rawRow.providerId,
    codeVerifier: rawRow.codeVerifier,
    scopesRequested: (rawRow.scopesRequested as string[]) ?? [],
    redirectUri: rawRow.redirectUri,
    createdAt: rawRow.createdAt?.toISOString() ?? "",
    expiresAt: rawRow.expiresAt.toISOString(),
  };

  // Check expiration
  if (new Date(stateRow.expiresAt) < new Date()) {
    await db.delete(oauthStates).where(eq(oauthStates.state, state));
    throw new Error("OAuth state has expired");
  }

  // Resolve the provider
  const provider = await getProviderOrThrow(db, stateRow.orgId, stateRow.providerId);
  if (!provider.tokenUrl) {
    throw new Error(`Provider '${stateRow.providerId}' has no token URL configured`);
  }

  const oauthCreds = await getProviderOAuthCredentialsOrThrow(
    db,
    stateRow.orgId,
    stateRow.providerId,
  );

  // Exchange code for tokens
  const useBasicAuth = provider.tokenAuthMethod === "client_secret_basic";

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: stateRow.redirectUri,
    ...(useBasicAuth
      ? {}
      : { client_id: oauthCreds.clientId, client_secret: oauthCreds.clientSecret }),
    ...(provider.pkceEnabled !== false ? { code_verifier: stateRow.codeVerifier } : {}),
    ...(provider.tokenParams ?? {}),
  });

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(provider.tokenUrl, {
      method: "POST",
      headers: buildTokenHeaders(
        provider.tokenAuthMethod,
        oauthCreds.clientId,
        oauthCreds.clientSecret,
      ),
      body: tokenBody.toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(
      `Token exchange network error for '${stateRow.providerId}': ${extractErrorMessage(err)}`,
    );
  }

  if (!tokenResponse.ok) {
    const body = await tokenResponse.text();
    throw new Error(`Token exchange failed: ${tokenResponse.status} ${body}`);
  }

  let tokenData: Record<string, unknown>;
  try {
    tokenData = (await tokenResponse.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`Token exchange returned non-JSON response for '${stateRow.providerId}'`);
  }

  const parsed = parseTokenResponse(
    tokenData,
    provider.scopeSeparator ?? " ",
    stateRow.scopesRequested,
  );

  // Clean up the OAuth state
  await db.delete(oauthStates).where(eq(oauthStates.state, state));

  return {
    providerId: stateRow.providerId,
    orgId: stateRow.orgId,
    userId: stateRow.userId,
    profileId: stateRow.profileId,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    expiresAt: parsed.expiresAt,
    scopesGranted: parsed.scopesGranted,
    rawResponse: tokenData,
  };
}
