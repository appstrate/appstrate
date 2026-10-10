// SPDX-License-Identifier: Apache-2.0

import { expect } from "bun:test";
import { decodeJwt } from "jose";

/** The request surface of the test app (`getTestApp()`), so any app instance fits. */
export interface TestAppLike {
  request(input: string, init?: RequestInit): Promise<Response> | Response;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export interface AuthorizationCodeFlowInput {
  cookie: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  resource: string;
}

export interface AuthorizationCodeFlowResult {
  /** Whether the consent screen stood between authorize and the code. */
  consentShown: boolean;
  /** The `/oauth2/token` JSON response. */
  token: Record<string, unknown>;
  /** The decoded access token. */
  claims: Record<string, unknown>;
}

/**
 * Full authorization-code + PKCE exchange as a signed-in platform user:
 * authorize → consent (unless a stored consent short-circuits it) → token.
 */
export async function authorizationCodeFlow(
  app: TestAppLike,
  input: AuthorizationCodeFlowInput,
): Promise<AuthorizationCodeFlowResult> {
  const { cookie, clientId, redirectUri, scope, resource } = input;
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const authorizeQuery = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state: "authorization-code-flow",
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
    resource,
  });
  const authorized = await app.request(`/api/auth/oauth2/authorize?${authorizeQuery}`, {
    headers: { cookie, accept: "text/html" },
    redirect: "manual",
  });
  expect(authorized.status).toBe(302);
  const authorizeTarget = new URL(authorized.headers.get("location")!, "http://localhost");
  // An `error` here is the provider bouncing the request back to the client
  // (`invalid_scope`, `invalid_target`, …) — name it instead of failing on the
  // missing code below.
  expect(authorizeTarget.searchParams.get("error")).toBeNull();

  // A stored consent short-circuits the consent screen and the authorization
  // response comes straight back on the callback.
  const consentShown = authorizeTarget.pathname === "/api/oauth/consent";
  let callback = authorizeTarget;
  if (consentShown) {
    const consentPage = await app.request(authorizeTarget.pathname + authorizeTarget.search, {
      headers: { cookie, accept: "text/html" },
    });
    expect(consentPage.status).toBe(200);
    const csrfCookie = (consentPage.headers.get("set-cookie") ?? "")
      .split(",")
      .map((c) => c.trim())
      .find((c) => c.startsWith("oidc_csrf="))!
      .split(";")[0]!;
    const csrfToken = (await consentPage.text()).match(/name="_csrf" value="([^"]+)"/)![1]!;

    const consented = await app.request(authorizeTarget.pathname + authorizeTarget.search, {
      method: "POST",
      headers: {
        cookie: `${cookie}; ${csrfCookie}`,
        "Content-Type": "application/x-www-form-urlencoded",
        accept: "application/json",
        origin: "http://localhost:3000",
      },
      body: new URLSearchParams({ _csrf: csrfToken, accept: "true" }).toString(),
      redirect: "manual",
    });
    expect([200, 302]).toContain(consented.status);
    const location = consented.headers.get("location");
    callback = location
      ? new URL(location, redirectUri)
      : new URL(String(((await consented.json()) as { url?: string }).url));
  }
  expect(callback.searchParams.get("error")).toBeNull();
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();

  const tokenRes = await app.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource,
    }).toString(),
  });
  const token = (await tokenRes.json()) as Record<string, unknown>;
  expect(token).not.toHaveProperty("error");
  expect(tokenRes.status).toBe(200);
  const claims = decodeJwt(String(token.access_token)) as Record<string, unknown>;
  return { consentShown, token, claims };
}
