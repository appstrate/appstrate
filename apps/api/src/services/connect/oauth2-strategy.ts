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
 * An auth declaring `connect.login` (`acquiresByConnectLogin`, AFPS §7.7) has no
 * `begin`: `complete` takes the submitted `fields`, renders the login's grant from
 * them and posts it to the token endpoint with the auth's client — the token request
 * a later refresh sends — then extracts identity (no `id_token`) and persists the same way.
 *
 * Re-acquisition (refresh) is not a strategy method — the live resolvers call
 * `refreshConnectionCredential`, since only `oauth2` refreshes.
 */

import { decodeJwtPayload } from "@appstrate/core/jwt";
import { acquiresByConnectLogin } from "@appstrate/core/integration";
import {
  initiateIntegrationOAuth,
  performTokenRequest,
  RefreshError,
  resolveOAuthEndpoints,
  oauthEgressFetch,
  SsrfBlockedError,
  type RefreshExchangeResult,
} from "@appstrate/connect";
import { LoginError, renderTokenGrant, type LoginConfig } from "@appstrate/connect/connect";
import { ApiError, invalidRequest } from "../../lib/errors.ts";
import { buildIntegrationOAuthRefreshContext } from "../integration-token-refresh.ts";
import { integrationCallbackUrl } from "../../lib/integration-callback-url.ts";
import {
  getRemoteSource,
  hasPerConnectionAuthServer,
  toSupportedTokenEndpointAuthMethod,
  type AfpsManifestAuth,
} from "../integration-manifest-helpers.ts";
import { resolveConnectionVariables } from "./connection-variables.ts";
import { logger } from "../../lib/logger.ts";
import { oauthStateStore } from "./oauth-state-store.ts";
import {
  assertEndpointsMatchMetadata,
  assertRequiredIdentityClaims,
  ensureIntegrationOAuthClient,
  extractIdentity,
  getIntegrationConnectionCredentialFields,
  readIntegrationAuth,
  resolveConnectClient,
  saveIntegrationConnection,
  type IntegrationConnectionSummary,
} from "../integration-connections.ts";
import {
  assertCredentialsMatchSchema,
  loginInputUnencodable,
  loginRejected,
  loginUpstreamUnavailable,
  requireNonEmptyCredentials,
  type BeginOptions,
  type BeginResult,
  type ConnectContext,
  type ConnectCompleteInput,
  type IntegrationConnectStrategy,
} from "./strategy.ts";

/**
 * Ceiling for the identity (`userinfo`) request. Deliberately tighter than the
 * 30s token-exchange budget: by the time this runs the credential is already
 * in hand, so waiting longer trades a saved connection for a nicer label.
 */
const USERINFO_TIMEOUT_MS = 10_000;

/**
 * The manifest's `_meta["dev.appstrate/oauth"].refresh_token_issuance`, when it
 * declares one.
 *
 * `"not_supported"` = the authorization server issues access-only tokens by
 * design (the connection re-authorises at expiry). `"default"` = it issues a
 * refresh token unconditionally, which needs no special handling here.
 */
function refreshTokenIssuance(auth: Record<string, unknown>): string | undefined {
  const meta = auth._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const oauthMeta = (meta as Record<string, unknown>)["dev.appstrate/oauth"];
  if (!oauthMeta || typeof oauthMeta !== "object") return undefined;
  const value = (oauthMeta as Record<string, unknown>).refresh_token_issuance;
  return typeof value === "string" ? value : undefined;
}

/**
 * Build the identity source for `extractIdentity`. Three layers, applied in
 * order so later layers don't overwrite earlier ones:
 *   1. Token response top-level (some IdPs put identity there).
 *   2. `id_token` JWT claims — OIDC providers, on the authorization-code flow only
 *      (`readIdToken`). No sig check: the channel that delivered the token was already
 *      vetted; claims are identity hints only. A `connect.login` token request answers a
 *      grant the user brought, with no nonce or authorization request to tie an `id_token`
 *      to (OIDC Core §3.1.3.7 validation is not performed), so its claims are not read.
 *   3. `userinfoUrl` GET — non-OIDC OAuth2 (GitHub, Slack, Notion, …).
 *      Without it, accountId falls back to "default" and every new
 *      connection collapses onto the same row.
 */
async function identitySourceFor(
  tokenResponse: Record<string, unknown>,
  accessToken: string,
  userinfoUrl: string | undefined,
  log: { packageId: string; authKey: string },
  readIdToken: boolean,
): Promise<Record<string, unknown>> {
  const identitySource: Record<string, unknown> = { ...tokenResponse };
  const idToken = readIdToken ? tokenResponse.id_token : undefined;
  if (typeof idToken === "string") {
    const claims = decodeJwtPayload(idToken);
    if (claims) {
      for (const [k, v] of Object.entries(claims)) {
        if (identitySource[k] === undefined) identitySource[k] = v;
      }
    }
  }
  if (!userinfoUrl) return identitySource;
  try {
    // SSRF-guarded: `userinfoUrl` is manifest-declared and fetched with the
    // user's access token. `oauthEgressFetch` does per-hop DNS + blocklist
    // and refuses loopback / RFC1918 / link-local / metadata targets
    // (throwing SsrfBlockedError, caught below) so a malicious manifest
    // can't exfiltrate the token to internal infra — unless the operator
    // opted the host into EGRESS_ALLOW_INTERNAL_HOSTS.
    const res = await oauthEgressFetch(userinfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": "Appstrate",
      },
      // `oauthEgressFetch` has no deadline; a stalled userinfo must not lose the granted credential.
      signal: AbortSignal.timeout(USERINFO_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = (await res.json()) as unknown;
      if (body && typeof body === "object") {
        for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
          if (identitySource[k] === undefined) identitySource[k] = v;
        }
      }
    } else {
      logger.warn("Integration userinfo fetch non-2xx", { ...log, status: res.status });
    }
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      // Best-effort: a blocked userinfo host skips enrichment (accountId
      // falls back to the manifest chain). Never log the access token.
      logger.warn("Integration userinfo URL blocked by SSRF guard", log);
    } else {
      logger.warn("Integration userinfo fetch failed", { ...log, err: String(err) });
    }
  }
  return identitySource;
}

type IntegrationManifestRead = Awaited<ReturnType<typeof readIntegrationAuth>>["manifest"];

/** The authorization server a connection is acquired from, as {@link authorizationServer} reads it. */
interface AuthorizationServer {
  issuer: string | undefined;
  /** The manifest's endpoints beside `issuer`, which discovery must not override. */
  declaredEndpoints: { authorizationEndpoint?: string; tokenEndpoint?: string };
  /** The manifest-declared `userinfo_endpoint`. */
  userinfoEndpoint: string | undefined;
}

/**
 * AFPS §7.3: a server chosen per connection is the validated issuer the flow carried
 * (`connectionIssuer`), the one the minting client is bound to, with no manifest endpoint beside
 * it; otherwise the manifest's issuer and endpoints.
 */
function authorizationServer(
  manifest: IntegrationManifestRead,
  auth: AfpsManifestAuth,
  connectionIssuer: string | undefined,
): AuthorizationServer {
  if (hasPerConnectionAuthServer(manifest, auth)) {
    return { issuer: connectionIssuer, declaredEndpoints: {}, userinfoEndpoint: undefined };
  }
  return {
    issuer: auth.issuer,
    declaredEndpoints: {
      ...(auth.authorization_endpoint
        ? { authorizationEndpoint: auth.authorization_endpoint }
        : {}),
      ...(auth.token_endpoint ? { tokenEndpoint: auth.token_endpoint } : {}),
    },
    userinfoEndpoint: auth.userinfo_endpoint,
  };
}

/**
 * Userinfo URL precedence (AFPS §7.3), the same fallback chain as
 * `code_challenge_methods_supported`:
 *   1. Manifest-declared `userinfo_endpoint` (authoritative).
 *   2. Discovery-projected `userinfo_endpoint` (a manifest that only declares
 *      an `issuer` rides on whatever the IdP advertises).
 *   3. undefined — the caller skips userinfo enrichment.
 */
async function resolveUserinfoUrl(
  server: AuthorizationServer,
  log: { packageId: string; authKey: string },
): Promise<string | undefined> {
  if (server.userinfoEndpoint) return server.userinfoEndpoint;
  if (!server.issuer) return undefined;
  try {
    const discovered = await resolveOAuthEndpoints({
      issuer: server.issuer,
      ...server.declaredEndpoints,
    });
    return discovered.userinfoEndpoint;
  } catch (err) {
    // Best-effort: discovery failures fall through to "no userinfo".
    logger.warn("Integration userinfo discovery failed", { ...log, err: String(err) });
    return undefined;
  }
}

/** The stored oauth2 credential bundle of a token response (RFC 6749 §5.1). */
function oauthCredentials(
  tokens: { accessToken: string; refreshToken: string | undefined; scopesGranted: string[] },
  tokenResponse: Record<string, unknown>,
): Record<string, unknown> {
  return {
    access_token: tokens.accessToken,
    ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
    ...(typeof tokenResponse.token_type === "string"
      ? { token_type: tokenResponse.token_type }
      : {}),
    ...(typeof tokenResponse.id_token === "string" ? { id_token: tokenResponse.id_token } : {}),
    scope: tokens.scopesGranted.join(" "),
  };
}

/** What a `connect.login` failure says once the token request may have reached the grant. */
const MAY_BE_REDEEMED =
  "The service may have redeemed the submitted grant: if a retry is refused, obtain a new one.";

/**
 * `err` once the token request may have redeemed the submitted grant: its detail says so, and the
 * RFC 9457 extension member `grant_may_be_redeemed: true` lets a client say it in its own words.
 */
function mayHaveRedeemed(err: ApiError): ApiError {
  return new ApiError({
    status: err.status,
    code: err.code,
    title: err.title,
    detail: `${err.message} ${MAY_BE_REDEEMED}`,
    param: err.param,
    retryAfter: err.retryAfter,
    errors: err.fieldErrors,
    headers: err.headers,
    extensions: { ...err.extensions, grant_may_be_redeemed: true },
    cause: err.cause ?? err,
  });
}

/** An auth this platform cannot connect yet: an administrator has something to set up. */
function connectionNotReady(detail: string): ApiError {
  return new ApiError({
    status: 409,
    code: "connection_not_ready",
    title: "Connection Not Ready",
    detail,
  });
}

/**
 * A failed `connect.login` token request as its API error. Unlike a refresh — where only
 * `invalid_grant` condemns a stored credential — a grant typed into a form that the token endpoint
 * answers with a 400 or 401 (RFC 6749 §5.2) is unusable as submitted. Any other 4xx (a 403 is
 * often a WAF refusing the client, a 429 a throttle) or a request the egress guard never sent
 * leaves the grant intact. Retry-After is not captured by the token request, so none is relayed.
 */
function tokenRequestRefusal(err: RefreshError): ApiError {
  if (err.kind === "revoked") {
    return loginRejected(
      "The service refused the submitted grant: it is invalid, expired or already used.",
      { kind: "grant" },
    );
  }
  if (err.kind === "client_rejected") {
    return new ApiError({
      status: 502,
      code: "oauth_client_rejected",
      title: "OAuth Client Rejected",
      detail:
        "The service rejected this integration's OAuth client. Ask an administrator to check its client registration.",
    });
  }
  const { status } = err;
  if (status === 400 || status === 401) {
    return loginRejected(
      `The service refused the token request (HTTP ${status}): the submitted grant cannot be used as given.`,
      { kind: "grant" },
    );
  }
  if (
    (status !== undefined && status >= 400 && status < 500) ||
    err.cause instanceof SsrfBlockedError
  ) {
    return loginUpstreamUnavailable(undefined);
  }
  // A timeout, a 5xx or an unusable 2xx may follow a redemption of a rotating grant.
  return mayHaveRedeemed(loginUpstreamUnavailable(undefined));
}

/** A grant the submitted fields cannot render, as its 400; a manifest fault stays the caller's 500. */
function grantRefusal(err: unknown): unknown {
  if (!(err instanceof LoginError)) return err;
  if (err.reason === "invalid_input") return loginInputUnencodable(err.field!);
  if (err.reason === "unresolved_placeholder") {
    return invalidRequest(
      `The submitted credentials leave the token request incomplete (${err.message}).`,
      "credentials",
    );
  }
  return err;
}

export class OAuth2Strategy implements IntegrationConnectStrategy {
  async begin(ctx: ConnectContext, opts: BeginOptions): Promise<BeginResult> {
    const { manifest, auth: rawAuth } = await readIntegrationAuth(
      ctx.scope,
      ctx.integrationId,
      ctx.authKey,
    );
    const auth = rawAuth as unknown as AfpsManifestAuth;
    if (acquiresByConnectLogin(auth)) {
      throw invalidRequest(
        `Auth '${ctx.authKey}' acquires its first token by connect.login, not through an authorization flow — use the fields flow`,
      );
    }
    // AFPS §7.12: validated before anything leaves the platform; carried in the OAuth state and
    // persisted with the credential at the callback.
    const variables = await resolveConnectionVariables(manifest, auth, ctx.variables);
    const perConnection = hasPerConnectionAuthServer(manifest, auth);
    // AFPS §7.3 / §7.4: `authorization_endpoint`, `token_endpoint`,
    // `resource`, `token_endpoint_auth_method`, `default_scopes`,
    // `code_challenge_methods_supported` (PKCE), `issuer` (discovery).
    // `scope_separator` lives under `_meta["dev.appstrate/oauth"]`.
    const oauthMeta = (auth._meta?.["dev.appstrate/oauth"] ?? undefined) as
      { scope_separator?: string } | undefined;
    // AFPS §7.3: an oauth2 auth declares EITHER an `issuer` (discovery fills the
    // endpoints in) OR explicit `authorization_endpoint` + `token_endpoint` —
    // except on a `remote` source, whose authorization server is discovered
    // from `source.remote.url` at connect time.
    if (
      !auth.issuer &&
      !getRemoteSource(manifest) &&
      (!auth.authorization_endpoint || !auth.token_endpoint)
    ) {
      throw invalidRequest(
        "oauth2 auth must declare an issuer (for discovery) or explicit authorization_endpoint + token_endpoint for marketplace connect.",
      );
    }
    // Same callback for every integration flow. Computed before client
    // resolution so auto-DCR registers exactly this redirect URI. Shared
    // helper, not an inline template: the admin UI displays the very same
    // string (integration detail `platform_redirect_uri`) so what an admin
    // registers at the provider cannot drift from what we send.
    const redirectUri = integrationCallbackUrl();
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
      variables ?? {},
    );
    // Client selection (multi-client) — full precedence lives in
    // `resolveConnectClient`. New connections always use the default (the
    // model-provider cascade). There is no per-connect picker. The chosen
    // `clientRef` is pinned on the connection so token refresh resolves the
    // same credentials.
    const {
      clientId,
      redirectUri: clientRedirectUri,
      redirectTag,
      clientRef,
    } = resolveConnectClient(
      ctx.integrationId,
      ctx.authKey,
      manifest,
      auth,
      resolved,
      ctx.target?.spaceId === null,
    );
    const effectiveRedirectUri = clientRedirectUri ?? redirectUri;
    // Threaded endpoints/resource: discovery result wins, manifest is the
    // fallback (classic integrations have no resolved.* fields).
    const issuer = resolved.issuer ?? auth.issuer;
    const authorizationEndpoint = resolved.authorizationEndpoint ?? auth.authorization_endpoint;
    const tokenEndpoint = resolved.tokenEndpoint ?? auth.token_endpoint;
    // A server chosen per connection takes no declared resource.
    const resource = perConnection ? resolved.resource : (resolved.resource ?? auth.resource);
    // AFPS §7.3 client binding on a remote source, a manually registered client included.
    if (getRemoteSource(manifest) && !perConnection && issuer) {
      assertEndpointsMatchMetadata(
        ctx.integrationId,
        ctx.authKey,
        auth,
        await resolveOAuthEndpoints({ issuer }),
      );
    }
    const result = await initiateIntegrationOAuth(oauthStateStore, {
      packageId: ctx.integrationId,
      authKey: ctx.authKey,
      ...(issuer ? { issuer } : {}),
      ...(authorizationEndpoint ? { authorizationEndpoint } : {}),
      ...(tokenEndpoint ? { tokenEndpoint } : {}),
      clientId,
      clientRef,
      scopes: opts.scopes,
      ...(oauthMeta?.scope_separator ? { scopeSeparator: oauthMeta.scope_separator } : {}),
      ...(resource ? { resource } : {}),
      ...(auth.code_challenge_methods_supported
        ? { codeChallengeMethodsSupported: auth.code_challenge_methods_supported }
        : {}),
      ...(auth.authorization_params ? { authorizationParams: auth.authorization_params } : {}),
      redirectUri: effectiveRedirectUri,
      orgId: ctx.scope.orgId,
      spaceId: ctx.scope.spaceId,
      actor: ctx.actor,
      forceAccountSelect: opts.forceAccountSelect ?? false,
      ...(ctx.target ? { connectionId: ctx.target.id } : {}),
      ...(ctx.delegated ? { delegated: true } : {}),
      // A per-server redirect URI (a server chosen per connection, or any metadata-document
      // client): the callback refuses a response that arrives through another path (mix-up).
      ...(redirectTag ? { redirectTag } : {}),
      // The server binding the client choice was made on, not a second discovery's answer.
      ...(resolved.authorizationServer
        ? { authorizationServer: resolved.authorizationServer }
        : {}),
      ...(variables ? { variables } : {}),
    });
    return { redirectUrl: result.authUrl, state: result.state };
  }

  async complete(
    ctx: ConnectContext,
    input: ConnectCompleteInput,
  ): Promise<IntegrationConnectionSummary> {
    if (input.kind === "fields") return this.completeFromLogin(ctx, input.credentials);
    const result = input.result;
    const { manifest, auth } = await readIntegrationAuth(ctx.scope, ctx.integrationId, ctx.authKey);
    const server = authorizationServer(manifest, auth as AfpsManifestAuth, result.issuer);
    const { issuer, declaredEndpoints } = server;
    const log = { packageId: result.packageId, authKey: result.authKey };
    const identitySource = await identitySourceFor(
      result.tokenResponse,
      result.accessToken,
      await resolveUserinfoUrl(server, log),
      log,
      true,
    );

    const { accountId, identityClaims } = extractIdentity(manifest, result.authKey, identitySource);
    // AFPS §7.4 — refuse the connection if any `required_identity_claims`
    // came back missing/empty from the IdP. Fail BEFORE persistence so a
    // half-identified connection never lands in `integration_connections`.
    assertRequiredIdentityClaims(manifest, result.authKey, identityClaims);

    // Re-auth (update) path: an IdP may omit `refresh_token` on re-consent
    // (e.g. Google without `prompt=consent`). Preserve the still-valid stored
    // token instead of clobbering it with none — mirrors the refresh path's
    // `parsed.refreshToken ?? refreshToken` carry-forward.
    let refreshToken = result.refreshToken;
    if (!refreshToken && result.connectionId) {
      const existing = await getIntegrationConnectionCredentialFields(result.connectionId);
      if (existing?.refresh_token) refreshToken = existing.refresh_token;
    }

    // A short-lived token (`expires_at` set) with no `refresh_token` is only a
    // misconfig when the authorization server CAN issue refresh tokens. Many MCP
    // servers (e.g. ClickUp MCP) advertise no `refresh_token` grant at all (RFC
    // 8414 `grant_types_supported`) — for them an access-only token is expected,
    // and the connection should persist and re-authorise at expiry
    // (needs_reconnection), not be refused outright. Keep the hard refusal for
    // servers that DO support refresh yet returned none — a real offline-access
    // misconfig (e.g. the original `@appstrate/gmail` self-disconnect: Google
    // without `access_type=offline` + `prompt=consent`).
    if (result.expiresAt && !refreshToken) {
      let refreshGrantSupported = true; // strict default when capability is unknown
      // A manifest that states the provider issues no refresh token at all is
      // authoritative — it is the same fact discovery would report, written
      // down for a provider that publishes no metadata. Without this the
      // declaration was inert: the conformance gate accepted
      // `refresh_token_issuance: "not_supported"` while this path still refused
      // the connection, so a manifest could pass CI and fail at consent.
      if (refreshTokenIssuance(auth) === "not_supported") {
        refreshGrantSupported = false;
      } else if (issuer) {
        try {
          const disc = await resolveOAuthEndpoints({ issuer, ...declaredEndpoints });
          if (disc.grantTypesSupported) {
            refreshGrantSupported = disc.grantTypesSupported.includes("refresh_token");
          }
        } catch (err) {
          // Discovery failure → keep the strict default (refuse). Logged for triage.
          logger.warn("Integration refresh-grant capability discovery failed", {
            packageId: result.packageId,
            authKey: result.authKey,
            err: String(err),
          });
        }
      }
      if (refreshGrantSupported) {
        // Refuse BEFORE persistence so a born-dead row never lands in
        // `integration_connections`.
        logger.warn("Integration OAuth returned short-lived token with no refresh_token", {
          packageId: result.packageId,
          authKey: result.authKey,
          ...(result.connectionId ? { connectionId: result.connectionId } : {}),
        });
        throw invalidRequest(
          `'${result.packageId}' returned a short-lived access token but no refresh token, so ` +
            `the connection cannot be kept alive. The integration's OAuth configuration is missing ` +
            `offline access (for Google: access_type=offline + prompt=consent), or a prior grant ` +
            `must be revoked in your account settings and re-authorised.`,
        );
      }
      // AS issues access-only tokens (no `refresh_token` grant advertised).
      // Persist; the connection surfaces needs_reconnection at expiry for a
      // manual re-auth — the only renewal path such a server supports.
      logger.info(
        "Integration OAuth connection persisted without a refresh token — authorization server advertises no refresh_token grant; re-authorisation required at expiry",
        {
          packageId: result.packageId,
          authKey: result.authKey,
          ...(result.connectionId ? { connectionId: result.connectionId } : {}),
        },
      );
    }

    return saveIntegrationConnection(ctx.scope, {
      packageId: result.packageId,
      authKey: result.authKey,
      accountId,
      credentials: oauthCredentials(
        { accessToken: result.accessToken, refreshToken, scopesGranted: result.scopesGranted },
        result.tokenResponse,
      ),
      identityClaims,
      scopesGranted: result.scopesGranted,
      expiresAt: result.expiresAt ? new Date(result.expiresAt) : null,
      actor: ctx.actor,
      ...(result.connectionId ? { connectionId: result.connectionId } : {}),
      ...(ctx.delegated ? { delegated: true } : {}),
      ...(ctx.onScopeWidened ? { onScopeWidened: ctx.onScopeWidened } : {}),
      clientRef: result.clientRef,
      variables: result.variables ?? null,
      ...(result.resource ? { oauthResource: result.resource } : {}),
    });
  }

  /**
   * `connect.login` acquisition (AFPS §7.7): the grant rendered from the submitted fields is posted
   * to the token endpoint with the auth's default client before anything is stored, so a dead,
   * mistyped or already-spent grant is a 400 on the form and never a born-dead connection. The
   * request is the one every later refresh sends (`performTokenRequest`), on the context the
   * refresh builds from the pinned client.
   */
  private async completeFromLogin(
    ctx: ConnectContext,
    submitted: Record<string, unknown>,
  ): Promise<IntegrationConnectionSummary> {
    const { manifest, auth: rawAuth } = await readIntegrationAuth(
      ctx.scope,
      ctx.integrationId,
      ctx.authKey,
    );
    const auth = rawAuth as unknown as AfpsManifestAuth;
    const login = auth.connect?.login;
    // Invariant: both fields routes send an oauth2 auth here only when it acquires by connect.login.
    if (!login) throw new Error(`Auth '${ctx.authKey}' declares no connect.login`);
    requireNonEmptyCredentials(submitted);
    const credentials = assertCredentialsMatchSchema(auth.credentials?.schema, submitted);
    let grant: Record<string, string>;
    try {
      grant = renderTokenGrant(login as LoginConfig["login"], credentials);
    } catch (err) {
      throw grantRefusal(err);
    }

    const variables = await resolveConnectionVariables(manifest, auth, ctx.variables);
    const resolved = await ensureIntegrationOAuthClient(
      ctx.scope,
      ctx.integrationId,
      ctx.authKey,
      manifest,
      auth,
      integrationCallbackUrl(),
      variables ?? {},
    );
    const { clientRef } = resolveConnectClient(
      ctx.integrationId,
      ctx.authKey,
      manifest,
      auth,
      resolved,
      ctx.target?.spaceId === null,
    );
    const oauthResource = resolved.resource ?? auth.resource ?? null;
    const log = { packageId: ctx.integrationId, authKey: ctx.authKey };
    let tokenContext: Awaited<ReturnType<typeof buildIntegrationOAuthRefreshContext>>;
    try {
      tokenContext = await buildIntegrationOAuthRefreshContext(
        ctx.integrationId,
        ctx.authKey,
        auth,
        ctx.scope.spaceId,
        { clientRef, oauthResource },
      );
    } catch (err) {
      if (err instanceof RefreshError && err.kind === "transient") {
        throw loginUpstreamUnavailable(undefined);
      }
      throw err;
    }
    // The manifest schema guarantees a token endpoint, and the client resolution above refuses an
    // auth with no usable client (403); what is left is the chosen client gone by now.
    if (!tokenContext) {
      logger.warn("Integration connect.login: no token request context", log);
      throw connectionNotReady(
        "This integration is not ready to be connected. Ask an administrator to finish setting it up, then try again.",
      );
    }
    // A client authentication `performTokenRequest` does not implement (`private_key_jwt`,
    // `client_secret_jwt`, `tls_client_auth`, …) narrows to "unspecified", which would send Basic.
    const declaredMethod = auth.token_endpoint_auth_method;
    if (
      tokenContext.tokenEndpointAuthMethod === undefined &&
      declaredMethod !== undefined &&
      toSupportedTokenEndpointAuthMethod(declaredMethod) === undefined
    ) {
      throw connectionNotReady(
        `This integration's OAuth client authenticates with '${declaredMethod}', which this platform does not support. Ask an administrator to register a client using client_secret_basic, client_secret_post or none.`,
      );
    }
    const server = authorizationServer(manifest, auth, resolved.issuer);
    // AFPS §7.3 client binding: the client is presented only to its issuer's own token endpoint.
    if (server.issuer && !hasPerConnectionAuthServer(manifest, auth)) {
      const metadata = await resolveOAuthEndpoints({ issuer: server.issuer });
      // Unverifiable is not verified: nothing is sent until the issuer's metadata answers.
      if (metadata.issuer === undefined) {
        logger.warn("Integration connect.login: issuer metadata unavailable", log);
        throw loginUpstreamUnavailable(undefined);
      }
      assertEndpointsMatchMetadata(
        ctx.integrationId,
        ctx.authKey,
        { token_endpoint: tokenContext.tokenEndpoint },
        metadata,
      );
    }

    let exchanged: RefreshExchangeResult;
    try {
      exchanged = await performTokenRequest(tokenContext, grant, {
        label: `Integration connect.login for '${ctx.integrationId}' auth '${ctx.authKey}'`,
        // RFC 6749 §6 / AFPS §7.7: a refresh-token grant answered without `refresh_token` keeps
        // the one it presented.
        ...(grant.grant_type === "refresh_token" && grant.refresh_token
          ? { keepRefreshToken: grant.refresh_token }
          : {}),
      });
    } catch (err) {
      // Every other throw is the request refused before sending (a malformed grant, an
      // incoherent client); only the egress guard's refusal of a built request is also unsent.
      if (err instanceof RefreshError && !(err.cause instanceof SsrfBlockedError)) {
        ctx.onGrantPresented?.();
      }
      if (!(err instanceof RefreshError)) throw err;
      logger.warn("Integration connect.login token request refused", {
        ...log,
        kind: err.kind,
        status: err.status,
      });
      throw tokenRequestRefusal(err);
    }
    ctx.onGrantPresented?.();

    // The request may have redeemed the submitted grant (a rotating server invalidates a refresh
    // token), so a failure from here on must say so.
    const { parsed, raw } = exchanged;
    try {
      // RFC 6749 §5.1 / §7.1: the delivery sends the token as a bearer token (RFC 6750); a token of
      // another type would fail every call, and its absence violates §5.1.
      const tokenType = raw.token_type;
      if (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer") {
        throw new ApiError({
          status: 502,
          code: "login_upstream_unavailable",
          title: "Login Upstream Unavailable",
          detail:
            typeof tokenType === "string"
              ? `The service issued a token of type '${tokenType}', not a bearer token: this integration cannot use it.`
              : "The service issued a token without a token_type: this integration uses bearer tokens only.",
        });
      }
      const identitySource = await identitySourceFor(
        raw,
        parsed.accessToken,
        await resolveUserinfoUrl(server, log),
        log,
        false,
      );
      const { accountId, identityClaims } = extractIdentity(manifest, ctx.authKey, identitySource);
      assertRequiredIdentityClaims(manifest, ctx.authKey, identityClaims);

      // RFC 6749 §5.1: a response without `scope` granted the scope requested.
      const scopesGranted =
        parsed.scopesReturned ?? grant.scope?.split(" ").filter((s) => s !== "") ?? [];
      return await saveIntegrationConnection(ctx.scope, {
        packageId: ctx.integrationId,
        authKey: ctx.authKey,
        accountId,
        credentials: oauthCredentials(
          { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, scopesGranted },
          raw,
        ),
        identityClaims,
        scopesGranted,
        expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
        actor: ctx.actor,
        ...(ctx.target ? { connectionId: ctx.target.id } : {}),
        ...(ctx.delegated ? { delegated: true } : {}),
        ...(ctx.onScopeWidened ? { onScopeWidened: ctx.onScopeWidened } : {}),
        clientRef,
        variables: variables ?? null,
        ...(oauthResource ? { oauthResource } : {}),
      });
    } catch (err) {
      logger.error("Integration connect.login: token request succeeded, connection not stored", {
        ...log,
        err: String(err),
      });
      throw mayHaveRedeemed(
        err instanceof ApiError
          ? err
          : new ApiError({
              status: 500,
              code: "internal_error",
              title: "Internal Error",
              detail: "The connection could not be stored.",
              cause: err,
            }),
      );
    }
  }
}
