// SPDX-License-Identifier: Apache-2.0

/**
 * A CONFORMANT OAuth2 authorization server for end-to-end tests.
 *
 * The existing `oauth-server.ts` mock answers `200` with a token for any
 * request it receives: it records what arrived but validates none of it. That
 * is exactly why it could not catch the defect that shipped — a token request
 * carrying `client_secret=` (empty, because the admin registered the app as a
 * public client while the manifest still declared `client_secret_post`) was
 * accepted by the mock and rejected by Dropbox with `invalid_client`.
 *
 * This server is the opposite: it REFUSES everything the RFCs say it should,
 * with the same error codes and statuses a real provider uses. Driving the
 * platform's own routes through it turns the OAuth flow into a protocol test —
 * a platform bug surfaces as a failed exchange here, in CI, deterministically,
 * instead of on a customer's consent screen.
 *
 * What it enforces:
 *
 *   | Rule                                             | RFC              |
 *   | ------------------------------------------------ | ---------------- |
 *   | `client_secret` present but empty → invalid_client | 6749 §2.3      |
 *   | Basic header with an empty secret → invalid_client | 6749 §2.3.1    |
 *   | client auth method outside the accepted set       | 7591 §2          |
 *   | `code_verifier` must match the `code_challenge`   | 7636 §4.6        |
 *   | `redirect_uri` identical to the authorize one     | 6749 §4.1.3      |
 *   | authorization code is single-use                  | 6749 §4.1.2      |
 *   | refresh token ONLY when offline access was asked  | provider-specific|
 *
 * That last row is the modelled half of the second defect: Google gates a
 * refresh token on `access_type=offline`, Dropbox on `token_access_type=offline`,
 * Reddit on `duration=permanent`. Configure {@link StrictOAuthProviderOptions.offlineParam}
 * with the flag this provider requires and the server behaves like it —
 * short-lived access token, no refresh token — when the authorize request
 * omits it.
 *
 * SSRF: the platform's OAuth egress is fail-closed against loopback addresses,
 * so a test using this server must allow its host explicitly (see
 * `allowLoopbackOAuthEgress` below) — the same `EGRESS_ALLOW_INTERNAL_HOSTS`
 * escape hatch a self-hoster uses for an internal IdP, not a test-only bypass.
 */

import { _resetCacheForTesting as resetEnvCache } from "@appstrate/env";

/** One request the server received, for post-hoc assertions. */
export interface RecordedTokenRequest {
  grantType: string;
  /** Parsed form body. */
  params: Record<string, string>;
  /** `Authorization` header verbatim, when the client sent one. */
  authorization?: string;
  /** What the server answered. */
  status: number;
  /** OAuth error code, when it refused. */
  error?: string;
}

/** One authorize request the server received. */
export interface RecordedAuthorizeRequest {
  params: Record<string, string>;
  status: number;
  error?: string;
}

export interface StrictOAuthProviderOptions {
  /** Client id registered at this provider. */
  clientId?: string;
  /**
   * Secret registered at this provider. `undefined` (the default) means the
   * app is registered as a PUBLIC client: it authenticates by `client_id`
   * alone and any secret-bearing request is refused.
   */
  clientSecret?: string;
  /**
   * Client-authentication methods this provider accepts. Defaults to the
   * method implied by `clientSecret`.
   */
  acceptedAuthMethods?: Array<"client_secret_post" | "client_secret_basic" | "none">;
  /**
   * Authorize-time flag this provider requires before it will issue a refresh
   * token (Google `access_type=offline`, Dropbox `token_access_type=offline`,
   * Reddit `duration=permanent`). Omit for a provider that issues one
   * unconditionally.
   */
  offlineParam?: { name: string; value: string };
  /** Access-token lifetime. Defaults to 1h, the common short-lived case. */
  expiresIn?: number;
  /** Require PKCE (RFC 7636). Defaults to true — every flow here is a code+PKCE flow. */
  requirePkce?: boolean;
}

export interface StrictOAuthProvider {
  /** Base URL, e.g. "http://localhost:54321". */
  url: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  stop: () => void;
  tokenRequests: RecordedTokenRequest[];
  authorizeRequests: RecordedAuthorizeRequest[];
  /** Every access token this server has minted, in order. */
  issuedAccessTokens: string[];
  /** Every refresh token this server has minted, in order. */
  issuedRefreshTokens: string[];
  reset: () => void;
}

/** Pending authorization code, bound to the request that created it. */
interface CodeGrant {
  redirectUri: string;
  codeChallenge?: string;
  scope: string;
  /** Whether the authorize request asked for offline access. */
  offline: boolean;
  used: boolean;
}

function oauthError(error: string, description: string, status = 400): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** RFC 7636 §4.6 — S256 verification. */
async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const b64 = Buffer.from(digest)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return b64 === challenge;
}

/**
 * Allow the platform's SSRF-guarded OAuth egress to reach a loopback IdP.
 *
 * This is the operator-facing `EGRESS_ALLOW_INTERNAL_HOSTS` opt-in, not a
 * test-only hole: without it the token exchange fails closed on `localhost`
 * and every flow test would fail for the wrong reason. Returns a restore
 * function — call it in `afterAll` so the guard is back on for other suites.
 */
export function allowLoopbackOAuthEgress(): () => void {
  const previous = process.env.EGRESS_ALLOW_INTERNAL_HOSTS;
  const hosts = new Set(
    (previous ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
  );
  hosts.add("localhost");
  hosts.add("127.0.0.1");
  process.env.EGRESS_ALLOW_INTERNAL_HOSTS = [...hosts].join(",");
  resetEnvCache();
  return () => {
    if (previous === undefined) delete process.env.EGRESS_ALLOW_INTERNAL_HOSTS;
    else process.env.EGRESS_ALLOW_INTERNAL_HOSTS = previous;
    resetEnvCache();
  };
}

/**
 * Start a conformant authorization server on an ephemeral port.
 *
 * `GET /authorize` validates the request and 302s back to `redirect_uri` with
 * a single-use code; `POST /token` serves `authorization_code` and
 * `refresh_token` grants. Both refuse non-conformant input with the RFC's own
 * error code, so a test asserts on the platform's behaviour rather than on a
 * mock's recorded bytes.
 */
export function createStrictOAuthProvider(
  options: StrictOAuthProviderOptions = {},
): StrictOAuthProvider {
  const clientId = options.clientId ?? "test-client-id";
  const registeredSecret = options.clientSecret;
  const accepted = new Set(
    options.acceptedAuthMethods ??
      (registeredSecret ? ["client_secret_post", "client_secret_basic"] : ["none"]),
  );
  const expiresIn = options.expiresIn ?? 3600;
  const requirePkce = options.requirePkce ?? true;

  const codes = new Map<string, CodeGrant>();
  const refreshTokens = new Map<string, { scope: string }>();
  const tokenRequests: RecordedTokenRequest[] = [];
  const authorizeRequests: RecordedAuthorizeRequest[] = [];
  const issuedAccessTokens: string[] = [];
  const issuedRefreshTokens: string[] = [];
  let counter = 0;
  const mint = (prefix: string): string => `${prefix}_${++counter}_${crypto.randomUUID()}`;

  /**
   * Authenticate the client exactly as an authorization server must, and
   * refuse the two shapes that motivated this fixture: a `client_secret`
   * parameter that is present but empty, and a Basic header whose password
   * half is empty. Both are what the platform sent when an admin registered a
   * public client against a manifest declaring a secret-based method.
   */
  function authenticateClient(
    params: Record<string, string>,
    authorization: string | null,
  ): { ok: true; method: string } | { ok: false; response: Response; error: string } {
    if (authorization) {
      if (!authorization.startsWith("Basic ")) {
        return {
          ok: false,
          error: "invalid_client",
          response: oauthError("invalid_client", "unsupported Authorization scheme", 401),
        };
      }
      const decoded = Buffer.from(authorization.slice(6), "base64").toString();
      const separator = decoded.indexOf(":");
      const id = decodeURIComponent(decoded.slice(0, separator === -1 ? undefined : separator));
      const secret = separator === -1 ? "" : decodeURIComponent(decoded.slice(separator + 1));
      if (!accepted.has("client_secret_basic")) {
        return {
          ok: false,
          error: "invalid_client",
          response: oauthError("invalid_client", "client_secret_basic not accepted", 401),
        };
      }
      if (secret === "") {
        return {
          ok: false,
          error: "invalid_client",
          response: oauthError(
            "invalid_client",
            "Basic credentials carry an empty client_secret",
            401,
          ),
        };
      }
      if (id !== clientId || secret !== registeredSecret) {
        return {
          ok: false,
          error: "invalid_client",
          response: oauthError("invalid_client", "bad client credentials", 401),
        };
      }
      return { ok: true, method: "client_secret_basic" };
    }

    if ("client_secret" in params) {
      if (params.client_secret === "") {
        // The defect, verbatim: an empty secret is not "no secret", it is a
        // wrong secret. Dropbox answers exactly this.
        return {
          ok: false,
          error: "invalid_client",
          response: oauthError("invalid_client", "client_secret present but empty"),
        };
      }
      if (!accepted.has("client_secret_post")) {
        return {
          ok: false,
          error: "invalid_client",
          response: oauthError("invalid_client", "client_secret_post not accepted"),
        };
      }
      if (params.client_id !== clientId || params.client_secret !== registeredSecret) {
        return {
          ok: false,
          error: "invalid_client",
          response: oauthError("invalid_client", "bad client credentials"),
        };
      }
      return { ok: true, method: "client_secret_post" };
    }

    // No credentials at all → public client. RFC 6749 §3.2.1: it MUST still
    // identify itself with `client_id`.
    if (!accepted.has("none")) {
      return {
        ok: false,
        error: "invalid_client",
        response: oauthError("invalid_client", "this client must authenticate"),
      };
    }
    if (params.client_id !== clientId) {
      return {
        ok: false,
        error: "invalid_client",
        response: oauthError("invalid_client", "missing or unknown client_id"),
      };
    }
    return { ok: true, method: "none" };
  }

  function handleAuthorize(url: URL): Response {
    const params = Object.fromEntries(url.searchParams.entries());
    const record = (status: number, error?: string): void => {
      authorizeRequests.push({ params, status, ...(error ? { error } : {}) });
    };
    const deny = (error: string, description: string): Response => {
      record(400, error);
      return oauthError(error, description);
    };

    if (params.client_id !== clientId) return deny("unauthorized_client", "unknown client_id");
    if (params.response_type !== "code") return deny("unsupported_response_type", "expected code");
    if (!params.redirect_uri) return deny("invalid_request", "redirect_uri is required");
    if (!params.state) return deny("invalid_request", "state is required");
    if (requirePkce) {
      if (!params.code_challenge) return deny("invalid_request", "code_challenge is required");
      if (params.code_challenge_method !== "S256") {
        return deny("invalid_request", "code_challenge_method must be S256");
      }
    }

    const offline = options.offlineParam
      ? params[options.offlineParam.name] === options.offlineParam.value
      : true;
    const code = mint("code");
    codes.set(code, {
      redirectUri: params.redirect_uri,
      ...(params.code_challenge ? { codeChallenge: params.code_challenge } : {}),
      scope: params.scope ?? "",
      offline,
      used: false,
    });
    record(302);
    const location = new URL(params.redirect_uri);
    location.searchParams.set("code", code);
    location.searchParams.set("state", params.state);
    return new Response(null, { status: 302, headers: { Location: location.toString() } });
  }

  async function handleToken(req: Request): Promise<Response> {
    const raw = await req.text();
    const params = Object.fromEntries(new URLSearchParams(raw).entries());
    const authorization = req.headers.get("Authorization");
    const record = (status: number, error?: string): void => {
      tokenRequests.push({
        grantType: params.grant_type ?? "",
        params,
        ...(authorization ? { authorization } : {}),
        status,
        ...(error ? { error } : {}),
      });
    };
    const deny = (error: string, description: string, status = 400): Response => {
      record(status, error);
      return oauthError(error, description, status);
    };

    const auth = authenticateClient(params, authorization);
    if (!auth.ok) {
      record(auth.response.status, auth.error);
      return auth.response;
    }

    if (params.grant_type === "authorization_code") {
      const grant = params.code ? codes.get(params.code) : undefined;
      if (!grant) return deny("invalid_grant", "unknown authorization code");
      if (grant.used) return deny("invalid_grant", "authorization code already redeemed");
      if (params.redirect_uri !== grant.redirectUri) {
        return deny("invalid_grant", "redirect_uri does not match the authorization request");
      }
      if (grant.codeChallenge) {
        if (!params.code_verifier) return deny("invalid_grant", "code_verifier is required");
        if (!(await verifyPkce(params.code_verifier, grant.codeChallenge))) {
          return deny("invalid_grant", "code_verifier does not match code_challenge");
        }
      }
      grant.used = true;

      const accessToken = mint("at");
      issuedAccessTokens.push(accessToken);
      const body: Record<string, unknown> = {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: expiresIn,
        scope: grant.scope,
      };
      // The modelled half of the second defect: no offline flag on the
      // authorize request → a short-lived token and NO refresh token.
      if (grant.offline) {
        const refreshToken = mint("rt");
        issuedRefreshTokens.push(refreshToken);
        refreshTokens.set(refreshToken, { scope: grant.scope });
        body.refresh_token = refreshToken;
      }
      record(200);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (params.grant_type === "refresh_token") {
      const stored = params.refresh_token ? refreshTokens.get(params.refresh_token) : undefined;
      if (!stored) return deny("invalid_grant", "unknown refresh token");
      const accessToken = mint("at");
      issuedAccessTokens.push(accessToken);
      record(200);
      return new Response(
        JSON.stringify({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: expiresIn,
          scope: stored.scope,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return deny("unsupported_grant_type", `grant_type '${params.grant_type ?? ""}' not supported`);
  }

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/authorize") return handleAuthorize(url);
      if (req.method === "POST" && url.pathname === "/token") return handleToken(req);
      return new Response("Not Found", { status: 404 });
    },
  });

  const base = `http://localhost:${server.port}`;
  return {
    url: base,
    authorizationEndpoint: `${base}/authorize`,
    tokenEndpoint: `${base}/token`,
    stop: () => server.stop(true),
    tokenRequests,
    authorizeRequests,
    issuedAccessTokens,
    issuedRefreshTokens,
    reset: () => {
      codes.clear();
      refreshTokens.clear();
      tokenRequests.length = 0;
      authorizeRequests.length = 0;
      issuedAccessTokens.length = 0;
      issuedRefreshTokens.length = 0;
    },
  };
}
