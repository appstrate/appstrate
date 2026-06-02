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
import { initiateIntegrationOAuth, resolveOAuthEndpoints } from "@appstrate/connect";
import { forbidden, invalidRequest } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";
import { oauthStateStore } from "./oauth-state-store.ts";
import {
  getRemoteSource,
  toSupportedTokenEndpointAuthMethod,
} from "../integration-manifest-helpers.ts";
import {
  assertRequiredIdentityClaims,
  ensureIntegrationOAuthClient,
  extractIdentity,
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
    const { manifest, auth: rawAuth } = await readIntegrationAuth(
      ctx.scope,
      ctx.integrationId,
      ctx.authKey,
    );
    const auth =
      rawAuth as unknown as import("../integration-manifest-helpers.ts").AfpsManifestAuth;
    // AFPS §7.3 / §7.4: `authorization_endpoint`, `token_endpoint`,
    // `resource`, `token_endpoint_auth_method`, `default_scopes`,
    // `code_challenge_methods_supported` (PKCE), `issuer` (discovery).
    // `scope_separator` lives under `_meta["dev.appstrate/oauth"]`.
    const oauthMeta = (auth._meta?.["dev.appstrate/oauth"] ?? undefined) as
      | { scope_separator?: string }
      | undefined;
    // Remote MCP integrations resolve their endpoints at connect time via the
    // MCP-spec discovery chain (RFC 9728 → RFC 8414) in
    // `ensureIntegrationOAuthClient`, so they need neither an `issuer` nor
    // explicit endpoints in the manifest. Forward-compat: AFPS §7.3 still
    // requires issuer-or-endpoints for oauth2 at the schema layer, so today's
    // remote connectors (ClickUp, Notion) declare an `issuer` and this branch is
    // never reached for them — it makes the connect path ready for a future
    // schema relaxation to truly zero-config (only `source.remote.url`).
    const isRemoteMcp = getRemoteSource(manifest) !== null;
    // AFPS §7.3: a non-remote oauth2 auth declares EITHER an `issuer` (discovery
    // fills the endpoints in) OR explicit `authorization_endpoint` +
    // `token_endpoint`.
    if (!isRemoteMcp && !auth.issuer && (!auth.authorization_endpoint || !auth.token_endpoint)) {
      throw invalidRequest(
        "oauth2 auth must declare an issuer (for discovery) or explicit authorization_endpoint + token_endpoint for marketplace connect.",
      );
    }
    // Same callback for every integration flow. Computed before client
    // resolution so auto-DCR registers exactly this redirect URI.
    const redirectUri = `${getEnv().APP_URL}/api/integrations/callback`;
    // Resolve the client (auto-registering via DCR for remote MCP integrations
    // when unregistered) and the connect endpoints/resource (discovered for
    // MCP, else manifest).
    const resolved = await ensureIntegrationOAuthClient(
      ctx.scope,
      ctx.integrationId,
      ctx.authKey,
      manifest,
      auth,
      redirectUri,
    );
    const client = resolved.client;
    if (!client) {
      throw forbidden(
        `Administrator must register OAuth client credentials for '${ctx.integrationId}' auth '${ctx.authKey}' before connection`,
      );
    }
    const effectiveRedirectUri = client.redirect_uri ?? redirectUri;
    // Threaded endpoints/resource: discovery result wins, manifest is the
    // fallback (classic integrations have no resolved.* fields).
    const issuer = resolved.issuer ?? auth.issuer;
    const authorizationEndpoint = resolved.authorizationEndpoint ?? auth.authorization_endpoint;
    const tokenEndpoint = resolved.tokenEndpoint ?? auth.token_endpoint;
    const resource = resolved.resource ?? auth.resource;
    const tokenAuthMethod = toSupportedTokenEndpointAuthMethod(auth.token_endpoint_auth_method);
    const result = await initiateIntegrationOAuth(oauthStateStore, {
      packageId: ctx.integrationId,
      authKey: ctx.authKey,
      ...(issuer ? { issuer } : {}),
      ...(authorizationEndpoint ? { authorizationEndpoint } : {}),
      ...(tokenEndpoint ? { tokenEndpoint } : {}),
      clientId: client.client_id,
      clientSecret: client.clientSecret,
      ...(tokenAuthMethod ? { tokenEndpointAuthMethod: tokenAuthMethod } : {}),
      scopes: opts.scopes,
      ...(oauthMeta?.scope_separator ? { scopeSeparator: oauthMeta.scope_separator } : {}),
      ...(resource ? { resource } : {}),
      ...(auth.code_challenge_methods_supported
        ? { codeChallengeMethodsSupported: auth.code_challenge_methods_supported }
        : {}),
      ...(auth.authorization_params
        ? { authorizationParams: auth.authorization_params as Record<string, string> }
        : {}),
      redirectUri: effectiveRedirectUri,
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
    const { manifest, auth } = await readIntegrationAuth(ctx.scope, ctx.integrationId, ctx.authKey);

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
    // Userinfo URL precedence (AFPS §7.3): mirror the same fallback chain
    // we apply for `code_challenge_methods_supported` —
    //   1. Manifest-declared `userinfo_endpoint` (authoritative).
    //   2. Discovery-projected `userinfo_endpoint` (a manifest that only
    //      declares an `issuer` rides on whatever the IdP advertises).
    //   3. undefined — caller skips userinfo enrichment.
    const manifestUserinfo = (auth as { userinfo_endpoint?: string }).userinfo_endpoint;
    let discoveredUserinfo: string | undefined;
    if (!manifestUserinfo && auth.issuer) {
      try {
        const discovered = await resolveOAuthEndpoints({
          issuer: auth.issuer,
          ...(auth.authorization_endpoint
            ? { authorizationEndpoint: auth.authorization_endpoint }
            : {}),
          ...(auth.token_endpoint ? { tokenEndpoint: auth.token_endpoint } : {}),
        });
        discoveredUserinfo = discovered.userinfoEndpoint;
      } catch (err) {
        // Best-effort: discovery failures fall through to "no userinfo".
        logger.warn("Integration userinfo discovery failed", {
          packageId: result.packageId,
          authKey: result.authKey,
          err: String(err),
        });
      }
    }
    const userinfoUrl = manifestUserinfo ?? discoveredUserinfo;
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
    // AFPS §7.4 — refuse the connection if any `required_identity_claims`
    // came back missing/empty from the IdP. Fail BEFORE persistence so a
    // half-identified connection never lands in `integration_connections`.
    assertRequiredIdentityClaims(manifest, result.authKey, identityClaims);
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
