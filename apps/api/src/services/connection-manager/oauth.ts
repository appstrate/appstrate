import { db } from "../../lib/db.ts";
import { logger } from "../../lib/logger.ts";
import { getEnv } from "@appstrate/env";
import {
  initiateOAuth,
  handleOAuthCallback,
  initiateOAuth1,
  handleOAuth1Callback,
  saveConnection,
  getProvider,
  type OAuthCallbackResult,
  type OAuth1CallbackResult,
} from "@appstrate/connect";
import type { Actor } from "../../lib/actor.ts";

export async function initiateConnection(
  provider: string,
  orgId: string,
  actor: Actor,
  profileId: string,
  requestedScopes?: string[],
): Promise<{ authUrl: string; state: string }> {
  const apiEnv = getEnv();
  const redirectUri = apiEnv.OAUTH_CALLBACK_URL ?? `http://localhost:${apiEnv.PORT}/auth/callback`;

  // Route to OAuth1 if the provider uses it
  const providerDef = await getProvider(db, orgId, provider);
  if (providerDef?.authMode === "oauth1") {
    return initiateOAuth1(db, orgId, actor, profileId, provider, redirectUri);
  }

  return initiateOAuth(db, orgId, actor, profileId, provider, redirectUri, requestedScopes);
}

export async function handleCallback(code: string, state: string): Promise<OAuthCallbackResult> {
  const result = await handleOAuthCallback(db, code, state);

  await saveConnection(
    db,
    result.profileId,
    result.providerId,
    result.orgId,
    {
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
    },
    {
      scopesGranted: result.scopesGranted,
      expiresAt: result.expiresAt,
    },
  );

  logger.info("OAuth connection established", {
    providerId: result.providerId,
    profileId: result.profileId,
    scopes: result.scopesGranted,
  });

  return result;
}

export async function handleOAuth1CallbackAndSave(
  oauthToken: string,
  oauthVerifier: string,
): Promise<OAuth1CallbackResult> {
  const result = await handleOAuth1Callback(db, oauthToken, oauthVerifier);

  await saveConnection(db, result.profileId, result.providerId, result.orgId, {
    consumer_key: result.consumerKey,
    access_token: result.accessToken,
    access_token_secret: result.accessTokenSecret,
  });

  logger.info("OAuth1 connection established", {
    providerId: result.providerId,
    profileId: result.profileId,
  });

  return result;
}
