// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth2 authorization-code + PKCE flow for AFPS integration `auths.{key}` of
 * type `oauth2` (AFPS §7.3).
 *
 * Pure module: takes pre-resolved endpoints + client credentials + an
 * {@link OAuthStateStore}, returns either an authorization URL (initiate)
 * or a parsed token response (callback). No DB, no HTTP-fetch
 * sourcing — the platform layer (`apps/api/src/services/integration-connections.ts`)
 * loads the manifest, resolves the registered OAuth client, and feeds
 * us. Exposes an initiate (authorization URL) and a callback (token
 * exchange) function for the integration OAuth flow.
 *
 * Notable AFPS inputs:
 *   - `resource` (RFC 8707) is sent on both the authorize URL and the token
 *     request — some IdPs only honour it on one of the two.
 *   - `code_challenge_methods_supported`: `["S256"]` ⇒ PKCE-S256; absent/empty
 *     ⇒ no PKCE.
 *   - `issuer` (optional) enables discovery-first endpoint resolution
 *     (RFC 8414 / OIDC). Discovery is best-effort; explicit endpoints always
 *     override the discovered ones.
 *
 * Refresh lives in `./token-refresh.ts` (`performRefreshTokenExchange`; the
 * `integration_connections` write-back wraps it in apps/api). A refresh POSTs
 * `grant_type=refresh_token` to the same `token_endpoint` (RFC 6749 §6).
 */

import type { Actor, OAuthStateRecord, OAuthStateStore } from "./types.ts";
import { OAuthCallbackError } from "./oauth.ts";
import { randomBase64Url, sha256Base64Url } from "./pkce.ts";
import { exchangeAuthorizationCode } from "./token-exchange.ts";
import { resolveOAuthEndpoints, type OAuthEndpointResolution } from "./oauth-discovery.ts";

const OAUTH_STATE_TTL_SECONDS = 10 * 60;

/**
 * Subject-id sentinel embedded in the {@link OAuthStateRecord} `subjectId`
 * for integration auth states. The callback reads the `integration`
 * field for the authoritative exchange params; this sentinel just makes
 * the state record self-describing for audit logging.
 */
function integrationSubjectIdSentinel(packageId: string, authKey: string): string {
  return `__integration__:${packageId}:${authKey}`;
}

/** PKCE-S256 marker as it appears in `code_challenge_methods_supported`. */
const PKCE_S256 = "S256";
/** PKCE-plain marker. RFC 7636 §4.2 — only used when the IdP does not advertise S256. */
const PKCE_PLAIN = "plain";

export interface InitiateIntegrationOAuthInput {
  /** Integration package id (e.g. `@official/gmail`). */
  packageId: string;
  /** Auth key as declared in `manifest.auths.{key}`. */
  authKey: string;
  /**
   * Authorization endpoint (`auths.{key}.authorization_endpoint`). Optional
   * when `issuer` is supplied for discovery — discovery then fills it in,
   * but an explicit value always wins.
   */
  authorizationEndpoint?: string;
  /**
   * Token endpoint (`auths.{key}.token_endpoint`). Carried into the state for
   * the callback. Optional when `issuer` is supplied for discovery.
   */
  tokenEndpoint?: string;
  /**
   * Issuer (`auths.{key}.issuer`) for discovery-first endpoint resolution
   * (RFC 8414 / OIDC `/.well-known/openid-configuration`). Best-effort — when
   * discovery fails, the manifest's explicit endpoints (if any) are used.
   */
  issuer?: string;
  /** OAuth2 client id registered by the admin. */
  clientId: string;
  /**
   * OAuth2 client secret — empty string for public clients
   * (`token_endpoint_auth_method=none`). Carried into state for the callback.
   */
  clientSecret: string;
  /**
   * Token endpoint client-auth method (`token_endpoint_auth_method`).
   *
   * AFPS (CC-10, §7.3, CHANGELOG): when the manifest does not specify
   * a value, the default is now `"client_secret_basic"` — the RFC 8414 §2 /
   * RFC 7591 §2 default. AFPS documented `"client_secret_post"` as the
   * default; the flip aligns with the OAuth 2.1 ecosystem (Anthropic, Google,
   * GitHub, Slack all accept Basic; some IdPs require it).
   *
   * Manifest-explicit values continue to work unchanged.
   */
  tokenEndpointAuthMethod?: "client_secret_post" | "client_secret_basic" | "none";
  /** Scopes requested in the authorize URL (joined per `scopeSeparator`). */
  scopes?: string[];
  /** Scope joiner (`_meta["dev.appstrate/oauth"].scope_separator`) — defaults to single space (OAuth2 standard). */
  scopeSeparator?: string;
  /** RFC 8707 `resource` parameter (`auths.{key}.resource`). */
  resource?: string;
  /**
   * Manifest-declared PKCE methods the IdP advertises
   * (`code_challenge_methods_supported`).
   *
   * Precedence: manifest (this field) > RFC 8414 discovery projection >
   * default `["S256"]`. Method selection within the effective list prefers
   * `"S256"` and falls back to `"plain"` only when `"S256"` is unavailable
   * (RFC 7636 §4.2). Empty array `[]` disables PKCE entirely.
   */
  codeChallengeMethodsSupported?: string[];
  /**
   * Extra static query params merged verbatim into the authorize URL
   * (from `manifest.auths.{key}.authorization_params`). Used by IdPs that
   * gate refresh-token issuance on an authorize-time flag (e.g. Google's
   * `access_type=offline` + `prompt=consent`). Merged last so a manifest
   * can override the dynamic `prompt`.
   */
  authorizationParams?: Record<string, string>;
  /** Platform redirect URI — same callback for all integration flows. */
  redirectUri: string;
  /** Org / app / actor context — propagated to the callback handler. */
  orgId: string;
  applicationId: string;
  actor: Actor;
  /**
   * When true, append `prompt=select_account` to the authorize URL so the
   * IdP shows the account picker instead of silently reusing the currently
   * signed-in session. Set by the UI when the user explicitly asks to add
   * a NEW connection — without it, the IdP would silently authorise the
   * already signed-in account.
   */
  forceAccountSelect?: boolean;
  /**
   * Reconnect / upgrade-scopes target. Threaded into the OAuth state so
   * the callback updates the named row instead of inserting a duplicate.
   * Absent on fresh connects.
   */
  connectionId?: string;
  /**
   * Optional discovery hook injection (testing seam). Production callers omit
   * it; the default fetches `${issuer}/.well-known/openid-configuration`.
   */
  discover?: typeof resolveOAuthEndpoints;
}

export interface InitiateIntegrationOAuthResult {
  authUrl: string;
  state: string;
}

/**
 * Build the PKCE-protected authorize URL and persist the matching state
 * record. The state record carries every field the callback will need —
 * endpoints, client credentials, resource — so the callback handler
 * never needs to re-fetch the manifest.
 */
export async function initiateIntegrationOAuth(
  store: OAuthStateStore,
  input: InitiateIntegrationOAuthInput,
): Promise<InitiateIntegrationOAuthResult> {
  // AFPS (CC-10, §7.3): default-when-missing flipped from
  // `"client_secret_post"` to `"client_secret_basic"` — RFC 8414 §2 /
  // RFC 7591 §2 default. Manifest-explicit values continue to work.
  const tokenAuthMethod = input.tokenEndpointAuthMethod ?? "client_secret_basic";
  const scopeSeparator = input.scopeSeparator ?? " ";
  const uniqueScopes = [...new Set(input.scopes ?? [])];
  const scopeString = uniqueScopes.join(scopeSeparator);

  // Discovery-first endpoint resolution (RFC 8414 / OIDC). Manual endpoints
  // always override the discovered ones; discovery is best-effort and only
  // attempted when an `issuer` is declared and an endpoint is missing.
  const endpoints: OAuthEndpointResolution = await (input.discover ?? resolveOAuthEndpoints)({
    issuer: input.issuer,
    authorizationEndpoint: input.authorizationEndpoint,
    tokenEndpoint: input.tokenEndpoint,
  });
  if (!endpoints.authorizationEndpoint) {
    throw new OAuthCallbackError(
      "No authorization_endpoint resolved (declare it on the auth or supply a discoverable issuer)",
      "transient",
      integrationSubjectIdSentinel(input.packageId, input.authKey),
    );
  }
  if (!endpoints.tokenEndpoint) {
    throw new OAuthCallbackError(
      "No token_endpoint resolved (declare it on the auth or supply a discoverable issuer)",
      "transient",
      integrationSubjectIdSentinel(input.packageId, input.authKey),
    );
  }

  // PKCE-method precedence (AFPS §7.3 + RFC 8414 §2):
  //   1. Manifest-declared `code_challenge_methods_supported` (authoritative).
  //   2. Discovery-projected `code_challenge_methods_supported` (RFC 8414 — a
  //      manifest that only declares an `issuer` rides on whatever the IdP
  //      advertises).
  //   3. Default `["S256"]` — MCP-spec parity + public-client code-binding.
  // Within the effective list, prefer S256; fall back to plain only when S256
  // is unavailable (RFC 7636 §4.2 — should be rare for modern IdPs).
  const pkceMethods = input.codeChallengeMethodsSupported ??
    endpoints.codeChallengeMethodsSupported ?? [PKCE_S256];
  const pkceMethod = pkceMethods.includes(PKCE_S256)
    ? PKCE_S256
    : pkceMethods.includes(PKCE_PLAIN)
      ? PKCE_PLAIN
      : null;
  const usePkce = pkceMethod !== null;

  const state = crypto.randomUUID();
  const codeVerifier = usePkce ? randomBase64Url(32) : "";
  const codeChallenge = !usePkce
    ? ""
    : pkceMethod === PKCE_S256
      ? sha256Base64Url(codeVerifier)
      : codeVerifier;

  const now = new Date();
  const record: OAuthStateRecord = {
    state,
    orgId: input.orgId,
    userId: input.actor.type === "user" ? input.actor.id : null,
    endUserId: input.actor.type === "end_user" ? input.actor.id : null,
    applicationId: input.applicationId,
    subjectId: integrationSubjectIdSentinel(input.packageId, input.authKey),
    codeVerifier,
    scopesRequested: uniqueScopes,
    redirectUri: input.redirectUri,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_SECONDS * 1000).toISOString(),
    integration: {
      packageId: input.packageId,
      authKey: input.authKey,
      tokenEndpoint: endpoints.tokenEndpoint,
      resource: input.resource,
      tokenEndpointAuthMethod: tokenAuthMethod,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    },
  };
  await store.set(state, record, OAUTH_STATE_TTL_SECONDS);

  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    state,
    ...(usePkce ? { code_challenge: codeChallenge, code_challenge_method: pkceMethod! } : {}),
    ...(scopeString ? { scope: scopeString } : {}),
    // RFC 8707 — bind the resulting token to a specific resource server.
    // Some IdPs require this on the authorize URL too (not just on the
    // token request); harmless when accepted-but-ignored.
    ...(input.resource ? { resource: input.resource } : {}),
    ...(input.forceAccountSelect ? { prompt: "select_account" } : {}),
    // Merged last: a manifest's authorization_params (e.g. Google's
    // access_type=offline + prompt=consent) wins over the dynamic prompt
    // so refresh-token issuance is never silently suppressed.
    ...(input.authorizationParams ?? {}),
  });

  const authUrl = `${endpoints.authorizationEndpoint}${endpoints.authorizationEndpoint.includes("?") ? "&" : "?"}${params.toString()}`;
  return { authUrl, state };
}

export interface IntegrationOAuthCallbackResult {
  packageId: string;
  authKey: string;
  orgId: string;
  applicationId: string;
  actor: Actor;
  accessToken: string;
  refreshToken?: string;
  expiresAt: string | null;
  scopesGranted: string[];
  scopeShortfall: string[];
  scopeCreep: string[];
  /**
   * Raw token-response JSON for callers that need extra claims
   * (`id_token`, custom IdP fields, …). The platform layer's identity
   * extraction (`identity_claims` JSONPaths) reads from here.
   */
  tokenResponse: Record<string, unknown>;
  /**
   * Pass-through of the reconnect/upgrade target id set at initiate
   * time. The callback handler hands this to `saveIntegrationConnection`
   * so the existing row is updated instead of a duplicate inserted.
   */
  connectionId?: string;
}

/**
 * Exchange the authorization code for tokens using the endpoints,
 * client credentials, and PKCE verifier we stored at initiate time.
 * Throws {@link OAuthCallbackError} with the same `kind` discrimination
 * across the connect surface so the routes layer can apply identical
 * UX (revoked → "please reconnect", transient → "retry").
 */
export async function handleIntegrationOAuthCallback(
  store: OAuthStateStore,
  code: string,
  state: string,
): Promise<IntegrationOAuthCallbackResult> {
  const stateRow = await store.get(state);
  if (!stateRow) {
    throw new OAuthCallbackError(
      "Invalid or expired OAuth state",
      "transient",
      // OAuthCallbackError carries a `subjectId`; use the sentinel
      // pattern so audit logs make sense.
      "__integration__:unknown",
    );
  }
  if (!stateRow.integration) {
    throw new OAuthCallbackError(
      "OAuth state is not an integration state — dispatcher mismatch",
      "transient",
      stateRow.subjectId,
    );
  }

  const integration = stateRow.integration;
  const sentinel = integrationSubjectIdSentinel(integration.packageId, integration.authKey);

  const { parsed, raw: tokenData } = await exchangeAuthorizationCode({
    tokenEndpoint: integration.tokenEndpoint,
    clientId: integration.clientId ?? "",
    clientSecret: integration.clientSecret ?? "",
    // AFPS (CC-10, §7.3): default-when-missing flipped from
    // `"client_secret_post"` to `"client_secret_basic"`.
    tokenEndpointAuthMethod: integration.tokenEndpointAuthMethod ?? "client_secret_basic",
    codeVerifier: stateRow.codeVerifier || undefined,
    redirectUri: stateRow.redirectUri,
    code,
    scopesRequested: stateRow.scopesRequested,
    // RFC 8707 — re-bind on the token request even if we sent it on the
    // authorize URL; some IdPs only honour it here.
    ...(integration.resource ? { extraTokenParams: { resource: integration.resource } } : {}),
    errorLabel: sentinel,
    state,
    store,
  });
  await store.delete(state);

  const actor: Actor = stateRow.endUserId
    ? { type: "end_user", id: stateRow.endUserId }
    : { type: "user", id: stateRow.userId! };

  return {
    packageId: integration.packageId,
    authKey: integration.authKey,
    orgId: stateRow.orgId,
    applicationId: stateRow.applicationId,
    actor,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    expiresAt: parsed.expiresAt,
    scopesGranted: parsed.scopesGranted,
    scopeShortfall: parsed.scopeShortfall,
    scopeCreep: parsed.scopeCreep,
    tokenResponse: tokenData,
    ...(integration.connectionId ? { connectionId: integration.connectionId } : {}),
  };
}
