// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth 1.0a (3-legged) flow implementation.
 * Uses HMAC-SHA1 signing per RFC 5849 — no external dependencies.
 */

import { randomBytes, createHmac } from "node:crypto";
import { eq, and, gt } from "drizzle-orm";
import { oauthStates } from "@appstrate/db/schema";
import type { Db } from "@appstrate/db/client";
import type { Actor } from "./types.ts";
import { getProviderOrThrow, getProviderOAuth1CredentialsOrThrow } from "./registry.ts";
import { extractErrorMessage, actorFromRow, actorToColumns } from "./utils.ts";

// ─── RFC 5849 Signing Internals ──────────────────────────────

/** RFC 5849 §3.6 — percent-encode per OAuth spec (stricter than encodeURIComponent). */
function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function generateNonce(): string {
  return randomBytes(16).toString("hex");
}

function generateTimestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

/**
 * Build the signature base string per RFC 5849 §3.4.1.
 * All params (query + body + oauth_*) are collected, sorted, and concatenated.
 */
function buildSignatureBaseString(
  method: string,
  baseUrl: string,
  params: [string, string][],
): string {
  const sorted = [...params].sort((a, b) => {
    const keyCompare = a[0].localeCompare(b[0]);
    return keyCompare !== 0 ? keyCompare : a[1].localeCompare(b[1]);
  });
  const paramString = sorted.map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`).join("&");
  return `${method.toUpperCase()}&${percentEncode(baseUrl)}&${percentEncode(paramString)}`;
}

/** HMAC-SHA1 → base64. */
function signHmacSha1(baseString: string, signingKey: string): string {
  return createHmac("sha1", signingKey).update(baseString).digest("base64");
}

/** Build the Authorization header from OAuth params. */
function buildOAuthHeader(params: Record<string, string>): string {
  const parts = Object.entries(params)
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(", ");
  return `OAuth ${parts}`;
}

// ─── Exported Flow Functions ─────────────────────────────────

export interface InitiateOAuth1Result {
  authUrl: string;
  state: string;
}

/**
 * Initiate an OAuth 1.0a authorization flow.
 * 1. Fetches a request token from the provider
 * 2. Stores the token + secret in oauth_states
 * 3. Returns the authorization URL for the user to visit
 */
export async function initiateOAuth1(
  db: Db,
  orgId: string,
  actor: Actor,
  profileId: string,
  providerId: string,
  callbackUrl: string,
  applicationId?: string,
): Promise<InitiateOAuth1Result> {
  const provider = await getProviderOrThrow(db, orgId, providerId);
  if (!provider.requestTokenUrl) {
    throw new Error(`Provider '${providerId}' has no requestTokenUrl configured`);
  }
  if (!provider.authorizationUrl) {
    throw new Error(`Provider '${providerId}' has no authorizationUrl configured`);
  }

  if (!applicationId) {
    throw new Error("Application context is required for OAuth1 connection");
  }
  const creds = await getProviderOAuth1CredentialsOrThrow(db, providerId, applicationId);

  // Build OAuth params for the request token call
  const nonce = generateNonce();
  const timestamp = generateTimestamp();
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_version: "1.0",
    oauth_callback: callbackUrl,
  };

  // Sign
  const allParams: [string, string][] = Object.entries(oauthParams);
  const baseString = buildSignatureBaseString("POST", provider.requestTokenUrl, allParams);
  const signingKey = `${percentEncode(creds.consumerSecret)}&`; // no token secret yet
  oauthParams.oauth_signature = signHmacSha1(baseString, signingKey);

  // POST to request token URL
  let response: Response;
  try {
    response = await fetch(provider.requestTokenUrl, {
      method: "POST",
      headers: {
        Authorization: buildOAuthHeader(oauthParams),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(
      `OAuth1 request token network error for '${providerId}': ${extractErrorMessage(err)}`,
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OAuth1 request token failed: ${response.status} ${body}`);
  }

  const responseText = await response.text();
  const responseParams = new URLSearchParams(responseText);
  const oauthToken = responseParams.get("oauth_token");
  const oauthTokenSecret = responseParams.get("oauth_token_secret");

  if (!oauthToken || !oauthTokenSecret) {
    throw new Error(`OAuth1 request token response missing oauth_token or oauth_token_secret`);
  }

  // Store in oauth_states — use oauth_token as the state key (lookup key in callback)
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await db.insert(oauthStates).values({
    state: oauthToken,
    orgId,
    ...actorToColumns(actor),
    profileId,
    providerId,
    applicationId,
    codeVerifier: "", // Not used for OAuth1, column is NOT NULL
    oauthTokenSecret,
    authMode: "oauth1",
    scopesRequested: [],
    redirectUri: callbackUrl,
    expiresAt,
  });

  // Build authorization URL (append provider-specific params like scope, expiration, name)
  const authParams = new URLSearchParams({ oauth_token: oauthToken });
  if (provider.authorizationParams) {
    for (const [k, v] of Object.entries(provider.authorizationParams)) {
      authParams.set(k, v);
    }
  }
  const authUrl = `${provider.authorizationUrl}?${authParams.toString()}`;

  return { authUrl, state: oauthToken };
}

export interface OAuth1CallbackResult {
  providerId: string;
  orgId: string;
  userId: string | null;
  actor: Actor;
  profileId: string;
  applicationId: string;
  consumerKey: string;
  accessToken: string;
  accessTokenSecret: string;
}

/**
 * Handle the OAuth 1.0a callback.
 * Exchanges the request token + verifier for an access token.
 */
export async function handleOAuth1Callback(
  db: Db,
  oauthToken: string,
  oauthVerifier: string,
): Promise<OAuth1CallbackResult> {
  // Look up the stored state by oauth_token
  const rows = await db
    .select()
    .from(oauthStates)
    .where(and(eq(oauthStates.state, oauthToken), gt(oauthStates.expiresAt, new Date())))
    .limit(1);

  if (rows.length === 0) {
    throw new Error("Invalid or expired OAuth1 state");
  }

  const stateRow = rows[0]!;

  if (stateRow.authMode !== "oauth1") {
    throw new Error("OAuth state is not an OAuth1 flow");
  }

  const oauthTokenSecret = stateRow.oauthTokenSecret;
  if (!oauthTokenSecret) {
    throw new Error("OAuth1 state missing token secret");
  }

  // Resolve the provider
  const provider = await getProviderOrThrow(db, stateRow.orgId, stateRow.providerId);
  if (!provider.accessTokenUrl) {
    throw new Error(`Provider '${stateRow.providerId}' has no accessTokenUrl configured`);
  }

  if (!stateRow.applicationId) {
    throw new Error("Application context is required for OAuth1 callback");
  }
  const creds = await getProviderOAuth1CredentialsOrThrow(
    db,
    stateRow.providerId,
    stateRow.applicationId,
  );

  // Build OAuth params for the access token call
  const nonce = generateNonce();
  const timestamp = generateTimestamp();
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_token: oauthToken,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_version: "1.0",
    oauth_verifier: oauthVerifier,
  };

  // Sign with consumer secret + token secret
  const allParams: [string, string][] = Object.entries(oauthParams);
  const baseString = buildSignatureBaseString("POST", provider.accessTokenUrl, allParams);
  const signingKey = `${percentEncode(creds.consumerSecret)}&${percentEncode(oauthTokenSecret)}`;
  oauthParams.oauth_signature = signHmacSha1(baseString, signingKey);

  // POST to access token URL
  let response: Response;
  try {
    response = await fetch(provider.accessTokenUrl, {
      method: "POST",
      headers: {
        Authorization: buildOAuthHeader(oauthParams),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(
      `OAuth1 access token network error for '${stateRow.providerId}': ${extractErrorMessage(err)}`,
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OAuth1 access token failed: ${response.status} ${body}`);
  }

  const responseText = await response.text();
  const responseParams = new URLSearchParams(responseText);
  const accessToken = responseParams.get("oauth_token");
  const accessTokenSecret = responseParams.get("oauth_token_secret");

  if (!accessToken || !accessTokenSecret) {
    throw new Error("OAuth1 access token response missing oauth_token or oauth_token_secret");
  }

  // Clean up the OAuth state
  await db.delete(oauthStates).where(eq(oauthStates.state, oauthToken));

  // Reconstruct actor from the stored columns
  const actor = actorFromRow(stateRow);

  return {
    providerId: stateRow.providerId,
    orgId: stateRow.orgId,
    userId: stateRow.userId ?? null,
    actor,
    profileId: stateRow.profileId,
    applicationId: stateRow.applicationId!,
    consumerKey: creds.consumerKey,
    accessToken,
    accessTokenSecret,
  };
}
