// SPDX-License-Identifier: Apache-2.0

import { db } from "@appstrate/db/client";
import { logger } from "../../lib/logger.ts";
import { getEnv } from "@appstrate/env";
import {
  initiateOAuth,
  handleOAuthCallback,
  initiateOAuth1,
  handleOAuth1Callback,
  saveConnection,
  getProvider,
  getProviderCredentialId,
  type OAuthCallbackResult,
  type OAuth1CallbackResult,
} from "@appstrate/connect";
import type { Actor } from "../../lib/actor.ts";

async function resolveProviderCredentialId(applicationId: string, providerId: string) {
  const id = await getProviderCredentialId(db, applicationId, providerId);
  if (!id)
    throw new Error(
      `No provider credentials for '${providerId}' in application '${applicationId}'`,
    );
  return id;
}

export function getOAuthCallbackUrl(): string {
  return `${getEnv().APP_URL}/api/connections/callback`;
}

export async function initiateConnection(
  provider: string,
  orgId: string,
  actor: Actor,
  profileId: string,
  applicationId: string,
  requestedScopes?: string[],
): Promise<{ authUrl: string; state: string }> {
  const redirectUri = getOAuthCallbackUrl();

  // Route to OAuth1 if the provider uses it
  const providerDef = await getProvider(db, orgId, provider);
  if (providerDef?.authMode === "oauth1") {
    return initiateOAuth1(db, orgId, actor, profileId, provider, redirectUri, applicationId);
  }

  return initiateOAuth(
    db,
    orgId,
    actor,
    profileId,
    provider,
    redirectUri,
    requestedScopes,
    applicationId,
  );
}

export async function handleCallback(code: string, state: string): Promise<OAuthCallbackResult> {
  const result = await handleOAuthCallback(db, code, state);

  const providerCredentialId = await resolveProviderCredentialId(
    result.applicationId,
    result.providerId,
  );

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
      providerCredentialId,
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

  const providerCredentialId = await resolveProviderCredentialId(
    result.applicationId,
    result.providerId,
  );

  await saveConnection(
    db,
    result.profileId,
    result.providerId,
    result.orgId,
    {
      consumer_key: result.consumerKey,
      access_token: result.accessToken,
      access_token_secret: result.accessTokenSecret,
    },
    {
      providerCredentialId,
    },
  );

  logger.info("OAuth1 connection established", {
    providerId: result.providerId,
    profileId: result.profileId,
  });

  return result;
}
