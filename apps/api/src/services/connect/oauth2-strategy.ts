// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth2Strategy — authorization-code + PKCE acquisition.
 *
 *   - `begin`    → client lookup + endpoint validation + PKCE authorize URL
 *                  (wraps `initiateIntegrationOAuth`). State lives in Redis.
 *   - `complete` → identity extraction (token response + id_token + userinfo)
 *                  + persist. The token exchange itself stays in the stateless
 *                  /callback route (it reconstructs actor/scope from the signed
 *                  state and owns the `OAuthCallbackError` UX mapping); this
 *                  consumes the already-exchanged result.
 *
 * Re-acquisition (refresh) is not a strategy method — the live resolvers call
 * `forceRefreshIntegrationConnection` directly, since only `oauth2` refreshes.
 *
 * Behaviour is unchanged from the inline route logic it replaces.
 */

import { getEnv } from "@appstrate/env";
import { decodeJwtPayload } from "@appstrate/core/jwt";
import { isBlockedUrl } from "@appstrate/core/ssrf";
import { initiateIntegrationOAuth } from "@appstrate/connect";
import { forbidden, invalidRequest } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";
import { oauthStateStore } from "./oauth-state-store.ts";
import {
  extractIdentity,
  getIntegrationOAuthClient,
  readIntegrationAuth,
  saveIntegrationConnection,
  type IntegrationConnectionSummary,
} from "../integration-connections.ts";
import type {
  BeginOptions,
  BeginResult,
  ConnectContext,
  ConnectCompleteInput,
  IntegrationConnectStrategy,
} from "./strategy.ts";

export class OAuth2Strategy implements IntegrationConnectStrategy {
  async begin(ctx: ConnectContext, opts: BeginOptions): Promise<BeginResult> {
    const { auth } = await readIntegrationAuth(ctx.scope, ctx.integrationPackageId, ctx.authKey);
    if (!auth.authorizationUrl || !auth.tokenUrl) {
      // The manifest schema requires explicit authorizationUrl + tokenUrl for
      // every oauth2 auth, so this is a defensive invariant (also narrows the
      // optional types for the call below).
      throw invalidRequest(
        "oauth2 auth must declare explicit authorizationUrl + tokenUrl for marketplace connect.",
      );
    }
    const client = await getIntegrationOAuthClient(
      ctx.scope,
      ctx.integrationPackageId,
      ctx.authKey,
    );
    if (!client) {
      throw forbidden(
        `Administrator must register OAuth client credentials for '${ctx.integrationPackageId}' auth '${ctx.authKey}' before connection`,
      );
    }
    const redirectUri = client.redirectUri ?? `${getEnv().APP_URL}/api/integrations/callback`;
    const result = await initiateIntegrationOAuth(oauthStateStore, {
      packageId: ctx.integrationPackageId,
      authKey: ctx.authKey,
      authorizationUrl: auth.authorizationUrl,
      tokenUrl: auth.tokenUrl,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      tokenAuthMethod: auth.tokenAuthMethod,
      scopes: opts.scopes,
      scopeSeparator: auth.scopeSeparator,
      audience: auth.audience,
      ...(auth.authorizationParams ? { authorizationParams: auth.authorizationParams } : {}),
      redirectUri,
      orgId: ctx.scope.orgId,
      applicationId: ctx.scope.applicationId,
      actor: ctx.actor,
      forceAccountSelect: opts.forceAccountSelect ?? false,
      ...(ctx.connectionId ? { connectionId: ctx.connectionId } : {}),
    });
    return { redirectUrl: result.authUrl, state: result.state };
  }

  async complete(
    ctx: ConnectContext,
    input: ConnectCompleteInput,
  ): Promise<IntegrationConnectionSummary> {
    if (input.kind !== "oauth2-result") {
      throw new Error(`OAuth2Strategy.complete: unexpected input kind '${input.kind}'`);
    }
    const result = input.result;
    const { manifest, auth } = await readIntegrationAuth(
      ctx.scope,
      ctx.integrationPackageId,
      ctx.authKey,
    );

    // Build the identity source for `extractIdentity`. Three layers, applied
    // in order so later layers don't overwrite earlier ones:
    //   1. Token response top-level (some IdPs put identity there).
    //   2. `id_token` JWT claims — OIDC providers. No sig check: PKCE + signed
    //      state already vetted the channel; claims are identity hints only.
    //   3. `userinfoUrl` GET — non-OIDC OAuth2 (GitHub, Slack, Notion, …).
    //      Without it, accountId falls back to "default" and every new
    //      connection collapses onto the same row.
    const identitySource: Record<string, unknown> = { ...result.tokenResponse };
    const idToken = result.tokenResponse.id_token;
    if (typeof idToken === "string") {
      const claims = decodeJwtPayload(idToken);
      if (claims) {
        for (const [k, v] of Object.entries(claims)) {
          if (identitySource[k] === undefined) identitySource[k] = v;
        }
      }
    }
    const userinfoUrl = auth.userinfoUrl;
    if (userinfoUrl && isBlockedUrl(userinfoUrl)) {
      // SSRF guard: `userinfoUrl` is manifest-declared and fetched with the
      // user's access token. Refuse loopback / RFC1918 / link-local / metadata
      // targets so a malicious manifest can't exfiltrate the token to internal
      // infra. Parity with the login engine's per-request guard.
      logger.warn("Integration userinfo URL blocked by SSRF guard", {
        packageId: result.packageId,
        authKey: result.authKey,
      });
    } else if (userinfoUrl) {
      try {
        const res = await fetch(userinfoUrl, {
          headers: {
            Authorization: `Bearer ${result.accessToken}`,
            Accept: "application/json",
            "User-Agent": "Appstrate",
          },
        });
        if (res.ok) {
          const body = (await res.json()) as unknown;
          if (body && typeof body === "object") {
            for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
              if (identitySource[k] === undefined) identitySource[k] = v;
            }
          }
        } else {
          logger.warn("Integration userinfo fetch non-2xx", {
            packageId: result.packageId,
            authKey: result.authKey,
            status: res.status,
          });
        }
      } catch (err) {
        logger.warn("Integration userinfo fetch failed", {
          packageId: result.packageId,
          authKey: result.authKey,
          err: String(err),
        });
      }
    }

    const { accountId, identityClaims } = extractIdentity(manifest, result.authKey, identitySource);
    const credentials: Record<string, unknown> = {
      access_token: result.accessToken,
      ...(result.refreshToken ? { refresh_token: result.refreshToken } : {}),
      ...(result.tokenResponse.token_type
        ? { token_type: String(result.tokenResponse.token_type) }
        : {}),
      ...(result.tokenResponse.id_token ? { id_token: String(result.tokenResponse.id_token) } : {}),
      scope: result.scopesGranted.join(" "),
    };
    return saveIntegrationConnection(ctx.scope, {
      packageId: result.packageId,
      authKey: result.authKey,
      accountId,
      credentials,
      identityClaims,
      scopesGranted: result.scopesGranted,
      expiresAt: result.expiresAt ? new Date(result.expiresAt) : null,
      actor: ctx.actor,
      ...(result.connectionId ? { connectionId: result.connectionId } : {}),
    });
  }
}
