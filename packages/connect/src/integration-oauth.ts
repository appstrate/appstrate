// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.3 — OAuth2 authorization-code + PKCE flow for AFPS integration
 * `auths.{key}` of type `oauth2` (proposal §4.1.1, §4.1.4).
 *
 * Pure module: takes pre-resolved endpoints + client credentials + an
 * {@link OAuthStateStore}, returns either an authorization URL (initiate)
 * or a parsed token response (callback). No DB, no HTTP-fetch
 * sourcing — the platform layer (`apps/api/src/services/integration-connections.ts`)
 * loads the manifest, resolves the registered OAuth client, and feeds
 * us. Mirrors the shape of {@link initiateOAuth} / {@link handleOAuthCallback}
 * in `./oauth.ts` so the connections route's callback dispatcher can
 * treat both paths uniformly.
 *
 * What this covers (Phase 1.3 ship scope):
 *   - **Mode A** explicit endpoints — `authorizationUrl`, `tokenUrl` come
 *     directly from `manifest.auths.{key}`.
 *   - PKCE S256 mandatory for public clients (`tokenAuthMethod=none`);
 *     opt-out impossible in this code path because the spec mandates it.
 *   - RFC 8707 `resource` parameter when the auth declares `audience`.
 *   - `client_secret_post` / `client_secret_basic` / `none` token endpoint
 *     auth methods — verified at the call site, defaults to `post`.
 *   - Scope shortfall / creep classification mirrored from the legacy
 *     OAuth handler.
 *
 * What lives elsewhere:
 *   - **Mode B** RFC 9728 discovery → `./oauth-discovery.ts` (resolves
 *     endpoints; caller plumbs result into `initiateIntegrationOAuth`).
 *   - DCR (RFC 7591) → `./dynamic-client-registration.ts` (caller may use
 *     it to obtain `clientId`/`clientSecret` before initiating).
 *   - Refresh, revoke → `./token-refresh.ts` (covers both legacy provider
 *     and integration paths).
 */

import type { Actor, OAuthStateRecord, OAuthStateStore } from "./types.ts";
import { OAuthCallbackError } from "./oauth.ts";
import { randomBase64Url, sha256Base64Url } from "./pkce.ts";
import { exchangeAuthorizationCode } from "./token-exchange.ts";

const OAUTH_STATE_TTL_SECONDS = 10 * 60;

/**
 * Provider identifier sentinel embedded in the {@link OAuthStateRecord}
 * for integration auth states. The OAuth callback dispatcher in
 * `apps/api/src/routes/connections.ts` checks the `integration` field
 * first; this sentinel just makes the state record self-describing for
 * audit logging.
 */
function integrationProviderIdSentinel(packageId: string, authKey: string): string {
  return `__integration__:${packageId}:${authKey}`;
}

export interface InitiateIntegrationOAuthInput {
  /** Integration package id (e.g. `@official/gmail`). */
  packageId: string;
  /** Auth key as declared in `manifest.auths.{key}`. */
  authKey: string;
  /** Authorization endpoint from the manifest. */
  authorizationUrl: string;
  /** Token endpoint from the manifest (carried into the state for the callback). */
  tokenUrl: string;
  /** OAuth2 client id registered by the admin. */
  clientId: string;
  /**
   * OAuth2 client secret — empty string for public clients
   * (`tokenAuthMethod=none`). Carried into state for the callback.
   */
  clientSecret: string;
  /** Token endpoint client-auth method. Defaults to `client_secret_post`. */
  tokenAuthMethod?: "client_secret_post" | "client_secret_basic" | "none";
  /** Scopes requested in the authorize URL (joined per `scopeSeparator`). */
  scopes?: string[];
  /** Scope joiner — defaults to single space (OAuth2 standard). */
  scopeSeparator?: string;
  /** RFC 8707 `resource` parameter when the auth declares `audience`. */
  audience?: string;
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
}

export interface InitiateIntegrationOAuthResult {
  authUrl: string;
  state: string;
}

/**
 * Build the PKCE-protected authorize URL and persist the matching state
 * record. The state record carries every field the callback will need —
 * endpoints, client credentials, audience — so the callback handler
 * never needs to re-fetch the manifest.
 */
export async function initiateIntegrationOAuth(
  store: OAuthStateStore,
  input: InitiateIntegrationOAuthInput,
): Promise<InitiateIntegrationOAuthResult> {
  const tokenAuthMethod = input.tokenAuthMethod ?? "client_secret_post";
  const scopeSeparator = input.scopeSeparator ?? " ";
  const uniqueScopes = [...new Set(input.scopes ?? [])];
  const scopeString = uniqueScopes.join(scopeSeparator);

  const state = crypto.randomUUID();
  const codeVerifier = randomBase64Url(32);
  const codeChallenge = sha256Base64Url(codeVerifier);

  const now = new Date();
  const record: OAuthStateRecord = {
    state,
    orgId: input.orgId,
    userId: input.actor.type === "user" ? input.actor.id : null,
    endUserId: input.actor.type === "end_user" ? input.actor.id : null,
    applicationId: input.applicationId,
    providerId: integrationProviderIdSentinel(input.packageId, input.authKey),
    codeVerifier,
    scopesRequested: uniqueScopes,
    redirectUri: input.redirectUri,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_SECONDS * 1000).toISOString(),
    authMode: "oauth2",
    integration: {
      packageId: input.packageId,
      authKey: input.authKey,
      tokenUrl: input.tokenUrl,
      audience: input.audience,
      tokenAuthMethod,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    },
  };
  await store.set(state, record, OAUTH_STATE_TTL_SECONDS);

  // PKCE S256 is mandatory for the integration OAuth path — spec §4.1.5
  // ties this to MCP authorization spec parity, plus public-client
  // security (some integrations declare `tokenAuthMethod=none` and rely
  // entirely on PKCE for code-binding).
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    ...(scopeString ? { scope: scopeString } : {}),
    // RFC 8707 — bind the resulting token to a specific resource server.
    // Some IdPs require this on the authorize URL too (not just on the
    // token request); harmless when accepted-but-ignored.
    ...(input.audience ? { resource: input.audience } : {}),
    ...(input.forceAccountSelect ? { prompt: "select_account" } : {}),
  });

  const authUrl = `${input.authorizationUrl}${input.authorizationUrl.includes("?") ? "&" : "?"}${params.toString()}`;
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
   * extraction (`extractTokenIdentity` JSONPaths) reads from here.
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
 * as the legacy provider path so the routes layer can apply identical
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
      // The legacy error type expects a `providerId`; use the sentinel
      // pattern so audit logs make sense.
      "__integration__:unknown",
    );
  }
  if (!stateRow.integration) {
    throw new OAuthCallbackError(
      "OAuth state is not an integration state — dispatcher mismatch",
      "transient",
      stateRow.providerId,
    );
  }

  const integration = stateRow.integration;
  const sentinel = integrationProviderIdSentinel(integration.packageId, integration.authKey);

  const { parsed, raw: tokenData } = await exchangeAuthorizationCode({
    tokenUrl: integration.tokenUrl,
    clientId: integration.clientId ?? "",
    clientSecret: integration.clientSecret ?? "",
    tokenAuthMethod: integration.tokenAuthMethod ?? "client_secret_post",
    codeVerifier: stateRow.codeVerifier,
    redirectUri: stateRow.redirectUri,
    code,
    scopesRequested: stateRow.scopesRequested,
    // RFC 8707 — re-bind on the token request even if we sent it on the
    // authorize URL; some IdPs only honour it here.
    ...(integration.audience ? { extraTokenParams: { resource: integration.audience } } : {}),
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
