// SPDX-License-Identifier: Apache-2.0

/**
 * OIDC PKCE helpers for the platform SPA.
 *
 * The SPA uses the OIDC authorize flow to route login through the shared
 * server-rendered login page. After login, the Better Auth session cookie
 * is the primary auth mechanism — OIDC tokens are only used to confirm
 * the user's identity at callback time.
 */

interface OidcConfig {
  clientId: string;
  issuer: string;
  // Canonical callback URL registered server-side on the instance client.
  // Use this verbatim — deriving it from `window.location.origin` breaks
  // when `APP_URL` differs from the browser origin (reverse proxy, TLS
  // termination, subdomain mismatch) and triggers `redirect_uri_mismatch`.
  callbackUrl: string;
}

export function getOidcConfig(): OidcConfig | undefined {
  return (window.__APP_CONFIG__ as unknown as Record<string, unknown>)?.oidc as
    | OidcConfig
    | undefined;
}

function base64url(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateCodeVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function calculateCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function generateState(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

const OIDC_STATE_KEY = "appstrate_oidc_state";
const OIDC_VERIFIER_KEY = "appstrate_oidc_verifier";
const OIDC_REDIRECT_KEY = "appstrate_oidc_redirect";

/**
 * Build the `URLSearchParams` shared by both the login (`/oauth2/authorize`)
 * and signup (`/api/oauth/register`) entry points and persist the PKCE
 * state for the eventual `/auth/callback` return.
 *
 * Both entry points feed the same underlying PKCE + authorize flow — the
 * server-rendered register page POSTs back to itself then redirects to
 * `/api/auth/oauth2/authorize${url.search}`, so the query string must
 * already carry every authorize parameter (including `resource` for the
 * RFC 8707 enforcement in `oidcGuardsPlugin`).
 */
async function initPkceFlow(
  config: OidcConfig,
  redirectTo: string | undefined,
): Promise<URLSearchParams> {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await calculateCodeChallenge(codeVerifier);

  sessionStorage.setItem(OIDC_STATE_KEY, state);
  sessionStorage.setItem(OIDC_VERIFIER_KEY, codeVerifier);
  if (redirectTo) sessionStorage.setItem(OIDC_REDIRECT_KEY, redirectTo);

  // `resource` is required by `oidcGuardsPlugin` (RFC 8707) on both the
  // authorize and token endpoints. `config.issuer` is one of the server's
  // `validAudiences` (`${APP_URL}/api/auth`). The SPA never consumes the
  // minted tokens — the BA session cookie is the real auth — but the
  // grant still has to succeed, so `resource` is non-negotiable.
  return new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    // `offline_access` deliberately omitted: the SPA discards the tokens
    // immediately after exchange (see `handleOidcCallback`), so a refresh
    // token would be dead weight persisted server-side with no consumer.
    scope: "openid profile email",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    resource: config.issuer,
  });
}

/**
 * Initiate the OIDC Authorization Code + PKCE flow for login.
 *
 * Redirects to the authorization endpoint; the server-rendered login page
 * handles authentication. On success the browser lands on `/auth/callback`
 * with an authorization code.
 */
export async function startOidcLogin(redirectTo?: string): Promise<void> {
  const config = getOidcConfig();
  if (!config) {
    throw new Error("OIDC not configured — window.__APP_CONFIG__.oidc is missing");
  }
  const params = await initPkceFlow(config, redirectTo);
  window.location.assign(`/api/auth/oauth2/authorize?${params.toString()}`);
}

/**
 * Initiate the OIDC PKCE flow for signup — same as login, but targets the
 * server-rendered registration page at `/api/oauth/register`. On successful
 * sign-up the server forwards to `/api/auth/oauth2/authorize${url.search}`,
 * reusing the same `state`/`code_challenge`/`resource` that were generated
 * here, so the callback handler cannot tell login and signup apart.
 */
export async function startOidcSignup(redirectTo?: string): Promise<void> {
  const config = getOidcConfig();
  if (!config) {
    throw new Error("OIDC not configured — window.__APP_CONFIG__.oidc is missing");
  }
  const params = await initPkceFlow(config, redirectTo);
  window.location.assign(`/api/oauth/register?${params.toString()}`);
}

/**
 * Handle the callback from the OIDC authorize endpoint.
 *
 * Validates the state, exchanges the code for tokens (to properly complete
 * the OIDC flow and prevent the code from being replayed), and returns the
 * post-login redirect path. The tokens themselves are discarded — the real
 * auth is the Better Auth session cookie set during login.
 */
export async function handleOidcCallback(): Promise<{ redirectTo: string }> {
  const config = getOidcConfig();
  if (!config) throw new Error("OIDC not configured");

  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");

  if (error) {
    throw new Error(`OIDC error: ${error}`);
  }
  if (!code || !state) {
    throw new Error("Missing code or state in callback");
  }

  const storedState = sessionStorage.getItem(OIDC_STATE_KEY);
  const codeVerifier = sessionStorage.getItem(OIDC_VERIFIER_KEY);
  const redirectTo = sessionStorage.getItem(OIDC_REDIRECT_KEY) ?? "/";

  sessionStorage.removeItem(OIDC_STATE_KEY);
  sessionStorage.removeItem(OIDC_VERIFIER_KEY);
  sessionStorage.removeItem(OIDC_REDIRECT_KEY);

  if (state !== storedState) {
    throw new Error("State mismatch — possible CSRF attack");
  }
  if (!codeVerifier) {
    throw new Error("Missing code verifier — session may have expired");
  }

  // `resource` MUST match one of the server's `validAudiences` — the
  // `oidcGuardsPlugin` rejects any `authorization_code`/`refresh_token`
  // grant without it (RFC 8707). `config.issuer` is that audience.
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.callbackUrl,
    client_id: config.clientId,
    code_verifier: codeVerifier,
    resource: config.issuer,
  });

  const res = await fetch("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Token exchange failed: ${res.status} ${detail.slice(0, 200)}`);
  }

  return { redirectTo };
}

/**
 * OIDC logout — redirect through the server-side logout endpoint.
 * Clears the BA session cookie + the OIDC session on the IdP side.
 */
export function startOidcLogout(): void {
  const config = getOidcConfig();
  if (!config) {
    window.location.assign("/login");
    return;
  }
  const logoutUrl = new URL("/api/oauth/logout", window.location.origin);
  logoutUrl.searchParams.set("client_id", config.clientId);
  logoutUrl.searchParams.set("post_logout_redirect_uri", window.location.origin + "/login");
  window.location.assign(logoutUrl.toString());
}
