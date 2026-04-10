// SPDX-License-Identifier: Apache-2.0

import { randomBytes, createHash } from "node:crypto";
import type { Db } from "@appstrate/db/client";
import type { OAuthStateRecord, OAuthStateStore } from "./types.ts";
import type { Actor } from "./types.ts";
import { getProviderOrThrow, getProviderOAuthCredentialsOrThrow } from "./registry.ts";
import { parseTokenResponse, buildTokenHeaders } from "./token-utils.ts";
import { extractErrorMessage } from "./utils.ts";

const OAUTH_STATE_TTL_SECONDS = 10 * 60;

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
  store: OAuthStateStore,
  orgId: string,
  actor: Actor,
  profileId: string,
  providerId: string,
  redirectUri: string,
  requestedScopes?: string[],
  applicationId?: string,
): Promise<InitiateOAuthResult> {
  const provider = await getProviderOrThrow(db, orgId, providerId, "oauth2");
  if (!provider.authorizationUrl) {
    throw new Error(`Provider '${providerId}' has no authorization URL configured`);
  }

  if (!applicationId) {
    throw new Error("Application context is required for OAuth2 connection");
  }
  const oauthCreds = await getProviderOAuthCredentialsOrThrow(db, providerId, applicationId);

  // Generate PKCE values
  const state = crypto.randomUUID();
  const codeVerifier = randomBase64Url(32);
  const codeChallenge = sha256Base64Url(codeVerifier);

  // Merge default + requested scopes
  const allScopes = [...(provider.defaultScopes ?? []), ...(requestedScopes ?? [])];
  const uniqueScopes = [...new Set(allScopes)];
  const scopeString = uniqueScopes.join(provider.scopeSeparator ?? " ");

  const now = new Date();
  const record: OAuthStateRecord = {
    state,
    orgId,
    userId: actor.type === "member" ? actor.id : null,
    endUserId: actor.type === "end_user" ? actor.id : null,
    applicationId,
    profileId,
    providerId,
    codeVerifier,
    scopesRequested: uniqueScopes,
    redirectUri,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_SECONDS * 1000).toISOString(),
    authMode: "oauth2",
  };
  await store.set(state, record, OAUTH_STATE_TTL_SECONDS);

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
  userId: string | null;
  actor: Actor;
  profileId: string;
  applicationId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: string | null;
  scopesGranted: string[];
}

/**
 * Handle the OAuth2 callback.
 * Exchanges the authorization code for tokens using PKCE.
 * Returns profileId from the stored oauth state.
 */
export async function handleOAuthCallback(
  db: Db,
  store: OAuthStateStore,
  code: string,
  state: string,
): Promise<OAuthCallbackResult> {
  const stateRow = await store.get(state);
  if (!stateRow) {
    throw new Error("Invalid or expired OAuth state");
  }

  const actor: Actor = stateRow.endUserId
    ? { type: "end_user", id: stateRow.endUserId }
    : { type: "member", id: stateRow.userId! };

  // Resolve the provider
  const provider = await getProviderOrThrow(db, stateRow.orgId, stateRow.providerId);
  if (!provider.tokenUrl) {
    throw new Error(`Provider '${stateRow.providerId}' has no token URL configured`);
  }

  const oauthCreds = await getProviderOAuthCredentialsOrThrow(
    db,
    stateRow.providerId,
    stateRow.applicationId,
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

  const parsed = parseTokenResponse(tokenData, stateRow.scopesRequested);

  // Clean up the OAuth state
  await store.delete(state);

  return {
    providerId: stateRow.providerId,
    orgId: stateRow.orgId,
    userId: stateRow.userId ?? null,
    actor,
    profileId: stateRow.profileId,
    applicationId: stateRow.applicationId,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    expiresAt: parsed.expiresAt,
    scopesGranted: parsed.scopesGranted,
  };
}
