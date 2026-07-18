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
    OidcConfig | undefined;
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

/**
 * OAuth `state` — CSRF nonce + post-login redirect carrier.
 *
 * The state is a base64url-encoded JSON payload `{ n, r? }`: `n` is a random
 * nonce (the CSRF property), `r` the optional post-login redirect path. The
 * authorize endpoint echoes `state` verbatim, so `r` survives server-side
 * detours that a new browsing context cannot: the email-verification flow
 * (`POST /api/oauth/register` with SMTP → "check your email" → link opens in
 * a NEW tab/device where `sessionStorage` is empty) resumes the OAuth flow
 * via the pinned `callbackURL` and still lands on `/auth/callback` with this
 * state — the only surviving carrier of where the user was headed.
 */
export function generateState(redirectTo?: string): string {
  const payload: { n: string; r?: string } = {
    n: base64url(crypto.getRandomValues(new Uint8Array(16))),
  };
  if (redirectTo) payload.r = redirectTo;
  return base64url(new TextEncoder().encode(JSON.stringify(payload)));
}

/**
 * Extract the post-login redirect from an echoed `state` parameter.
 *
 * Returns `undefined` for anything that is not a same-origin relative path —
 * malformed base64/JSON (including legacy opaque random states), absolute
 * URLs, and protocol-relative `//host` forms — so a crafted callback URL can
 * never turn this into an open redirect.
 */
export function decodeStateRedirect(state: string): string | undefined {
  try {
    const b64 = state.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const r = (parsed as Record<string, unknown>).r;
    if (typeof r !== "string") return undefined;
    if (!r.startsWith("/") || r.startsWith("//") || r.includes("\\")) return undefined;
    return r;
  } catch {
    return undefined;
  }
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
  loginHint?: string,
): Promise<URLSearchParams> {
  const state = generateState(redirectTo);
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
  const params = new URLSearchParams({
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

  // OIDC `login_hint` (standard param) — the oauth-provider carries it
  // through (signed) to the server-rendered login/register pages, which
  // pre-fill and lock the email field. Used by the invitation flow to pin
  // the invited address. Purely UX: the accept endpoint re-checks that the
  // session email matches the invitation server-side, so a tampered field
  // cannot escape it.
  if (loginHint) params.set("login_hint", loginHint);

  return params;
}

/**
 * Initiate the OIDC Authorization Code + PKCE flow for login.
 *
 * Redirects to the authorization endpoint; the server-rendered login page
 * handles authentication. On success the browser lands on `/auth/callback`
 * with an authorization code.
 */
export async function startOidcLogin(redirectTo?: string, loginHint?: string): Promise<void> {
  const config = getOidcConfig();
  if (!config) {
    throw new Error("OIDC not configured — window.__APP_CONFIG__.oidc is missing");
  }
  const params = await initPkceFlow(config, redirectTo, loginHint);
  window.location.assign(`/api/auth/oauth2/authorize?${params.toString()}`);
}

/**
 * Initiate the OIDC PKCE flow for signup — same as login, but targets the
 * server-rendered registration page at `/api/oauth/register`. On successful
 * sign-up the server forwards to `/api/auth/oauth2/authorize${url.search}`,
 * reusing the same `state`/`code_challenge`/`resource` that were generated
 * here, so the callback handler cannot tell login and signup apart.
 */
export async function startOidcSignup(redirectTo?: string, loginHint?: string): Promise<void> {
  const config = getOidcConfig();
  if (!config) {
    throw new Error("OIDC not configured — window.__APP_CONFIG__.oidc is missing");
  }
  const params = await initPkceFlow(config, redirectTo, loginHint);
  window.location.assign(`/api/oauth/register?${params.toString()}`);
}

/**
 * Handle the callback from the OIDC authorize endpoint.
 *
 * Same-context flow (the common case): validates the state against the
 * `sessionStorage` copy, exchanges the code for tokens (to properly complete
 * the OIDC flow and prevent the code from being replayed), and returns the
 * post-login redirect path. The tokens themselves are discarded — the real
 * auth is the Better Auth session cookie set during login.
 *
 * Cross-context resume: the email-verification flow pauses the OAuth dance
 * ("check your email") and resumes it via the link in the email — which
 * opens in a NEW tab or device where `sessionStorage` is empty (it is
 * per-tab). There is then no stored state to compare and no PKCE verifier to
 * exchange with, but neither is needed: Better Auth's
 * `autoSignInAfterVerification` already set the session cookie, and the SPA
 * discards the tokens anyway. So when NO state was ever stored in this
 * context we skip the exchange and recover the redirect from the echoed
 * `state` payload. The caller MUST validate the session afterwards
 * (`refreshAuth()` in `auth-callback.tsx` throws when no session exists) —
 * that session check is what authenticates this path. A crafted callback URL
 * gains nothing here: the attacker-supplied code is never exchanged, and the
 * decoded redirect is constrained to a same-origin relative path.
 *
 * A PRESENT-but-different stored state remains a hard failure (CSRF guard).
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

  if (storedState === null) {
    // Cross-context resume (see the function doc): nothing was ever stored
    // in this tab, so there is no verifier to exchange with. Skip the token
    // exchange — the BA session cookie is the real auth, and the caller
    // validates it right after. The unexchanged code simply expires.
    return { redirectTo: decodeStateRedirect(state) ?? "/" };
  }

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

  // Untyped on purpose: end-user-realm OAuth token exchange — the typed
  // client's middleware would inject platform X-Org-Id/X-Application-Id
  // headers into the grant, which is wrong in this realm.
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
 *
 * The post-logout redirect always lands on `/login` (the only URI the
 * server validates against the client's registered `postLogoutRedirectUris`
 * — an exact-match check, so a dynamic path like `/invite/:token` can't be
 * passed there). To still return the user somewhere specific after they
 * re-authenticate, `postLoginRedirect` is stashed in the same
 * `OIDC_REDIRECT_KEY` that `handleOidcCallback` consumes: logout → `/login`
 * → the gate re-runs `startOidcLogin(undefined)` (which does NOT overwrite
 * the key) → the callback reads the stash and returns there. Used by the
 * invite "log out and retry" path so a wrong-account user lands back on the
 * invitation after signing in with the correct account.
 */
export function startOidcLogout(postLoginRedirect?: string): void {
  const config = getOidcConfig();
  if (postLoginRedirect) {
    sessionStorage.setItem(OIDC_REDIRECT_KEY, postLoginRedirect);
  }
  if (!config) {
    window.location.assign("/login");
    return;
  }
  const logoutUrl = new URL("/api/oauth/logout", window.location.origin);
  logoutUrl.searchParams.set("client_id", config.clientId);
  logoutUrl.searchParams.set("post_logout_redirect_uri", window.location.origin + "/login");
  window.location.assign(logoutUrl.toString());
}
