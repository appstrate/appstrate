// SPDX-License-Identifier: Apache-2.0

/**
 * OIDC PKCE helpers for the platform SPA.
 *
 * The SPA uses the OIDC authorize flow to route login through the shared
 * server-rendered login page. After login, the Better Auth session cookie
 * is the primary auth mechanism — OIDC tokens are only used to confirm
 * the user's identity at callback time.
 */

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
 * Initiate the OIDC Authorization Code + PKCE flow.
 *
 * Stores state + code_verifier in sessionStorage, then redirects to the
 * authorization endpoint. The server-rendered login page handles
 * authentication — on success the browser is redirected back to
 * `/auth/callback` with an authorization code.
 */
export async function startOidcLogin(redirectTo?: string): Promise<void> {
  const config = window.__APP_CONFIG__?.oidc;
  if (!config) {
    throw new Error("OIDC not configured — window.__APP_CONFIG__.oidc is missing");
  }

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await calculateCodeChallenge(codeVerifier);

  // Persist for the callback
  sessionStorage.setItem(OIDC_STATE_KEY, state);
  sessionStorage.setItem(OIDC_VERIFIER_KEY, codeVerifier);
  if (redirectTo) sessionStorage.setItem(OIDC_REDIRECT_KEY, redirectTo);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: `${window.location.origin}/auth/callback`,
    scope: "openid profile email offline_access",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  window.location.assign(`/api/auth/oauth2/authorize?${params.toString()}`);
}

/**
 * Handle the callback from the OIDC authorize endpoint.
 *
 * Validates the state, exchanges the code for tokens (to complete the
 * OIDC flow properly), and returns the redirect path. The actual auth
 * relies on the Better Auth session cookie set during login.
 */
export async function handleOidcCallback(): Promise<{ redirectTo: string }> {
  const config = window.__APP_CONFIG__?.oidc;
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

  // Clean up
  sessionStorage.removeItem(OIDC_STATE_KEY);
  sessionStorage.removeItem(OIDC_VERIFIER_KEY);
  sessionStorage.removeItem(OIDC_REDIRECT_KEY);

  if (state !== storedState) {
    throw new Error("State mismatch — possible CSRF attack");
  }
  if (!codeVerifier) {
    throw new Error("Missing code verifier — session may have expired");
  }

  // Exchange code for tokens to properly complete the OIDC flow.
  // The tokens themselves aren't needed (we use the BA session cookie),
  // but exchanging the code prevents it from being replayed.
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: `${window.location.origin}/auth/callback`,
    client_id: config.clientId,
    code_verifier: codeVerifier,
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
  const config = window.__APP_CONFIG__?.oidc;
  if (!config) {
    // Fallback: just navigate to login
    window.location.assign("/login");
    return;
  }
  const logoutUrl = new URL("/api/oauth/logout", window.location.origin);
  logoutUrl.searchParams.set("client_id", config.clientId);
  logoutUrl.searchParams.set("post_logout_redirect_uri", window.location.origin + "/login");
  window.location.assign(logoutUrl.toString());
}
