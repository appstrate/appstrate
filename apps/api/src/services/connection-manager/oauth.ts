// SPDX-License-Identifier: Apache-2.0

import { db } from "@appstrate/db/client";
import { logger } from "../../lib/logger.ts";
import { getEnv } from "@appstrate/env";
import { and, eq } from "drizzle-orm";
import { userProviderConnections } from "@appstrate/db/schema";
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
import { resolveProviderCredentialId } from "./helpers.ts";
import { oauthStateStore } from "./oauth-state-store.ts";
import type { AppScope } from "../../lib/scope.ts";

export function getOAuthCallbackUrl(): string {
  return `${getEnv().APP_URL}/api/connections/callback`;
}

export async function initiateConnection(
  scope: AppScope,
  provider: string,
  actor: Actor,
  profileId: string,
  requestedScopes?: string[],
): Promise<{ authUrl: string; state: string }> {
  const redirectUri = getOAuthCallbackUrl();

  // Route to OAuth1 if the provider uses it
  const providerDef = await getProvider(db, scope.orgId, provider);
  if (providerDef?.authMode === "oauth1") {
    return initiateOAuth1(
      db,
      oauthStateStore,
      scope.orgId,
      actor,
      profileId,
      provider,
      redirectUri,
      scope.applicationId,
    );
  }

  return initiateOAuth(
    db,
    oauthStateStore,
    scope.orgId,
    actor,
    profileId,
    provider,
    redirectUri,
    requestedScopes,
    scope.applicationId,
  );
}

export async function handleCallback(code: string, state: string): Promise<OAuthCallbackResult> {
  const result = await handleOAuthCallback(db, oauthStateStore, code, state);

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

  // Scope shortfall: provider granted fewer scopes than requested (RFC 6749 §3.3
  // narrowing). Flag the connection so callers see a structured "needs reconnection"
  // signal instead of silently working with reduced permissions.
  if (result.scopeShortfall.length > 0) {
    logger.warn("OAuth scope shortfall — flagging connection as needsReconnection", {
      providerId: result.providerId,
      profileId: result.profileId,
      shortfall: result.scopeShortfall,
    });
    await db
      .update(userProviderConnections)
      .set({ needsReconnection: true, updatedAt: new Date() })
      .where(
        and(
          eq(userProviderConnections.profileId, result.profileId),
          eq(userProviderConnections.providerId, result.providerId),
          eq(userProviderConnections.orgId, result.orgId),
          eq(userProviderConnections.providerCredentialId, providerCredentialId),
        ),
      );
  }

  // Scope creep: provider returned more scopes than requested. Some providers
  // (Slack, GitHub legacy) always return all owner scopes, so this is non-blocking.
  if (result.scopeCreep.length > 0) {
    logger.warn("OAuth scope creep — provider granted unrequested scopes", {
      providerId: result.providerId,
      profileId: result.profileId,
      creep: result.scopeCreep,
    });
  }

  logger.info("OAuth connection established", {
    providerId: result.providerId,
    profileId: result.profileId,
    scopes: result.scopesGranted,
    shortfall: result.scopeShortfall.length > 0 ? result.scopeShortfall : undefined,
  });

  return result;
}

export async function handleOAuth1CallbackAndSave(
  oauthToken: string,
  oauthVerifier: string,
): Promise<OAuth1CallbackResult> {
  const result = await handleOAuth1Callback(db, oauthStateStore, oauthToken, oauthVerifier);

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
