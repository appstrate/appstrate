// SPDX-License-Identifier: Apache-2.0

/** OIDC PKCE helpers for the SPA: the Better Auth session cookie is the real auth, the OIDC tokens are discarded. */

interface OidcConfig {
  clientId: string;
  issuer: string;
  // Use verbatim: deriving it from `window.location.origin` breaks behind a
  // reverse proxy (`redirect_uri_mismatch`).
  callbackUrl: string;
}

function getOidcConfig(): OidcConfig | undefined {
  return (window.__APP_CONFIG__ as unknown as Record<string, unknown>)?.oidc as
    OidcConfig | undefined;
}

function base64url(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateCodeVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function calculateCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** OAuth `state`: base64url JSON `{ n, r? }` (CSRF nonce, post-login redirect); the only carrier surviving the email-verification new tab. */
export function generateState(redirectTo?: string): string {
  const payload: { n: string; r?: string } = {
    n: base64url(crypto.getRandomValues(new Uint8Array(16))),
  };
  if (redirectTo) payload.r = redirectTo;
  return base64url(new TextEncoder().encode(JSON.stringify(payload)));
}

/** Post-login redirect from an echoed `state`; `undefined` unless a same-origin relative path (no open redirect). */
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

/** Authorize params for login and signup (the register page forwards `url.search`), plus PKCE state persistence. */
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

  // `resource` (RFC 8707) is required by `oidcGuardsPlugin` on authorize and
  // token; `config.issuer` is one of the server's protected resources.
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    // No `offline_access`: the tokens are discarded, a refresh token would have no consumer.
    scope: "openid profile email",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    resource: config.issuer,
  });

  // Pre-fills and locks the email on the hosted pages (invitation flow). Purely
  // UX: the accept endpoint re-checks the session email server-side.
  if (loginHint) params.set("login_hint", loginHint);

  return params;
}

export async function startOidcLogin(redirectTo?: string, loginHint?: string): Promise<void> {
  const config = getOidcConfig();
  if (!config) {
    throw new Error("OIDC not configured — window.__APP_CONFIG__.oidc is missing");
  }
  const params = await initPkceFlow(config, redirectTo, loginHint);
  window.location.assign(`/api/auth/oauth2/authorize?${params.toString()}`);
}

/** Same as login, but targets the registration page; the callback cannot tell the two apart. */
export async function startOidcSignup(redirectTo?: string, loginHint?: string): Promise<void> {
  const config = getOidcConfig();
  if (!config) {
    throw new Error("OIDC not configured — window.__APP_CONFIG__.oidc is missing");
  }
  const params = await initPkceFlow(config, redirectTo, loginHint);
  window.location.assign(`/api/oauth/register?${params.toString()}`);
}

/**
 * Handle the authorize callback: validate `state`, exchange the code (tokens
 * are discarded), return the post-login redirect.
 *
 * Cross-context resume (email-verification link opened in a new tab, so no
 * stored state or verifier): skip the exchange and recover the redirect from
 * `state`. The caller MUST validate the session afterwards (`refreshAuth()`) —
 * that check is what authenticates this path; the code is never exchanged and
 * the redirect is same-origin only. A PRESENT-but-different stored state stays
 * a hard failure (CSRF guard).
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
    // Cross-context resume (see the function doc); the unexchanged code just expires.
    return { redirectTo: decodeStateRedirect(state) ?? "/" };
  }

  if (state !== storedState) {
    throw new Error("State mismatch — possible CSRF attack");
  }
  if (!codeVerifier) {
    throw new Error("Missing code verifier — session may have expired");
  }

  // `oidcGuardsPlugin` rejects a grant without `resource` (RFC 8707).
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.callbackUrl,
    client_id: config.clientId,
    code_verifier: codeVerifier,
    resource: config.issuer,
  });

  // Untyped on purpose: the typed client's middleware would inject platform
  // X-Org-Id/X-Space-Id headers, wrong in this end-user realm.
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
 * Post-logout always lands on `/login` (exact-match `postLogoutRedirectUris`), so
 * `postLoginRedirect` is stashed under `OIDC_REDIRECT_KEY`; `startOidcLogin(undefined)` keeps it.
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
