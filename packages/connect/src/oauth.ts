import { randomBytes, createHash } from "node:crypto";
import type { OAuthStateRecord } from "./types.ts";
import { getProviderOrThrow, getProviderOAuthCredentialsOrThrow } from "./registry.ts";
import type { SupabaseClient } from "./registry.ts";
import { parseTokenResponse } from "./token-utils.ts";
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
 */
export async function initiateOAuth(
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
  providerId: string,
  redirectUri: string,
  requestedScopes?: string[],
): Promise<InitiateOAuthResult> {
  const provider = await getProviderOrThrow(supabase, orgId, providerId, "oauth2");
  if (!provider.authorizationUrl) {
    throw new Error(`Provider '${providerId}' has no authorization URL configured`);
  }

  const oauthCreds = await getProviderOAuthCredentialsOrThrow(supabase, orgId, providerId);

  // Generate PKCE values
  const state = crypto.randomUUID();
  const codeVerifier = randomBase64Url(32);
  const codeChallenge = sha256Base64Url(codeVerifier);

  // Merge default + requested scopes
  const allScopes = [
    ...(provider.defaultScopes ?? []),
    ...(requestedScopes ?? []),
  ];
  const uniqueScopes = [...new Set(allScopes)];
  const scopeString = uniqueScopes.join(provider.scopeSeparator ?? " ");

  // Store OAuth state in DB
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await supabase.from("oauth_states").insert({
    state,
    org_id: orgId,
    user_id: userId,
    provider_id: providerId,
    code_verifier: codeVerifier,
    scopes_requested: uniqueScopes,
    redirect_uri: redirectUri,
    expires_at: expiresAt,
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
  accessToken: string;
  refreshToken?: string;
  expiresAt: string | null;
  scopesGranted: string[];
  rawResponse: Record<string, unknown>;
}

/**
 * Handle the OAuth2 callback.
 * Exchanges the authorization code for tokens using PKCE.
 */
export async function handleOAuthCallback(
  supabase: SupabaseClient,
  code: string,
  state: string,
): Promise<OAuthCallbackResult> {
  // Look up the OAuth state (filter expired states at DB level)
  const { data: rawRow, error: stateError } = await supabase
    .from("oauth_states")
    .select("*")
    .eq("state", state)
    .gt("expires_at", new Date().toISOString())
    .single();

  if (stateError && !rawRow) {
    throw new Error(`OAuth state lookup failed: ${extractErrorMessage(stateError)}`);
  }
  if (!rawRow) {
    throw new Error("Invalid or expired OAuth state");
  }

  // Map snake_case DB columns to camelCase
  const stateRow: OAuthStateRecord = {
    state: rawRow.state as string,
    orgId: rawRow.org_id as string,
    userId: rawRow.user_id as string,
    providerId: rawRow.provider_id as string,
    codeVerifier: rawRow.code_verifier as string,
    scopesRequested: rawRow.scopes_requested as string[],
    redirectUri: rawRow.redirect_uri as string,
    createdAt: rawRow.created_at as string,
    expiresAt: rawRow.expires_at as string,
  };

  // Check expiration
  if (new Date(stateRow.expiresAt) < new Date()) {
    // Clean up expired state
    await supabase.from("oauth_states").delete().eq("state", state);
    throw new Error("OAuth state has expired");
  }

  // Resolve the provider
  const provider = await getProviderOrThrow(supabase, stateRow.orgId, stateRow.providerId);
  if (!provider.tokenUrl) {
    throw new Error(`Provider '${stateRow.providerId}' has no token URL configured`);
  }

  const oauthCreds = await getProviderOAuthCredentialsOrThrow(supabase, stateRow.orgId, stateRow.providerId);

  // Exchange code for tokens
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: stateRow.redirectUri,
    client_id: oauthCreds.clientId,
    client_secret: oauthCreds.clientSecret,
    ...(provider.pkceEnabled !== false
      ? { code_verifier: stateRow.codeVerifier }
      : {}),
    ...(provider.tokenParams ?? {}),
  });

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(provider.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(`Token exchange network error for '${stateRow.providerId}': ${extractErrorMessage(err)}`);
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
  await supabase.from("oauth_states").delete().eq("state", state);

  return {
    providerId: stateRow.providerId,
    orgId: stateRow.orgId,
    userId: stateRow.userId,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    expiresAt: parsed.expiresAt,
    scopesGranted: parsed.scopesGranted,
    rawResponse: tokenData,
  };
}
