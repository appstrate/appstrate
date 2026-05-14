// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth 2.0 Resource Owner Password Credentials grant (RFC 6749 §4.3).
 *
 * Used by legacy providers (Amisgest, Fizz, …) that only expose ROPC.
 *
 * ROPC is **deprecated in OAuth 2.1** and discouraged for new integrations —
 * it exposes user credentials to the client and breaks MFA/SSO. The platform
 * supports it as a clearly-flagged escape hatch when the upstream leaves
 * operators no choice.
 *
 * Modeled on `./oauth.ts` (PKCE authorization code) — same error semantics,
 * same token-endpoint helpers, same revocation classification.
 */

import type { OAuthTokenAuthMethod, OAuthTokenContentType } from "@appstrate/core/validation";
import {
  parseTokenResponse,
  parseTokenErrorResponse,
  buildTokenHeaders,
  buildTokenBody,
  type ParsedTokenResponse,
  type TokenErrorKind,
} from "./token-utils.ts";
import { extractErrorMessage } from "./utils.ts";

/**
 * Error thrown by `exchangePasswordGrant` and `refreshPasswordGrantToken`
 * when the token endpoint call fails.
 *
 * Mirrors {@link import("./oauth.ts").OAuthCallbackError} so callers can
 * apply the same revocation handling across the three OAuth2 paths:
 *
 * - `"revoked"`: HTTP 400 + `{ "error": "invalid_grant" }` per RFC 6749 §5.2.
 *   For the password grant this means the upstream rejected the
 *   username/password (or a stored refresh_token). Caller MUST flag the
 *   connection as `needsReconnection`.
 * - `"transient"`: every other failure mode (network, 5xx, non-JSON body,
 *   other 4xx, other OAuth error codes). Credentials might still be valid —
 *   caller MUST NOT flag the connection.
 */
export class PasswordGrantError extends Error {
  constructor(
    message: string,
    public readonly kind: TokenErrorKind,
    public readonly providerId: string,
    public readonly status?: number,
    public readonly body?: string,
    public readonly oauthError?: string,
    public readonly oauthErrorDescription?: string,
  ) {
    super(message);
    this.name = "PasswordGrantError";
  }
}

/**
 * Configuration for an ROPC token endpoint call.
 *
 * Mirrors the OAuth2 provider definition fields read by `oauth.ts` so
 * downstream callers can pull a single config object from the resolved
 * provider definition and pass it through to both bootstrap and refresh.
 */
export interface PasswordGrantContext {
  /** OAuth2 token endpoint (RFC 6749 §3.2). */
  tokenUrl: string;
  /** OAuth2 client identifier — optional for public clients. */
  clientId?: string;
  /** OAuth2 client secret — optional for public clients. */
  clientSecret?: string;
  /**
   * How client credentials are sent. Defaults to `client_secret_post`.
   * When `client_secret_basic` is set, credentials are sent via the
   * Authorization header (RFC 6749 §2.3.1).
   */
  tokenAuthMethod?: OAuthTokenAuthMethod;
  /**
   * Token request content type. Defaults to `application/x-www-form-urlencoded`
   * (RFC 6749 §4.3.2). Some providers (rare in the ROPC world) require JSON.
   */
  tokenContentType?: OAuthTokenContentType;
  /**
   * Space-separated scope string, sent in the token request body.
   * Optional — most ROPC providers don't honor scope at the token endpoint.
   */
  scope?: string;
  /**
   * Provider identifier — used purely for error reporting. The token
   * endpoint never sees this value.
   */
  providerId: string;
}

const TOKEN_TIMEOUT_MS = 30_000;

async function postTokenRequest(
  ctx: PasswordGrantContext,
  bodyParams: Record<string, string>,
): Promise<ParsedTokenResponse> {
  const useBasicAuth = ctx.tokenAuthMethod === "client_secret_basic";

  const params: Record<string, string> = { ...bodyParams };
  if (ctx.scope) {
    params.scope = ctx.scope;
  }

  // Client credentials are sent either in the body (default,
  // `client_secret_post`) or in the Authorization header
  // (`client_secret_basic`). Public clients (no clientSecret) just omit
  // both — RFC 6749 §4.3.2 makes client authentication conditional on the
  // upstream's policy.
  if (!useBasicAuth && ctx.clientId) {
    params.client_id = ctx.clientId;
    if (ctx.clientSecret) {
      params.client_secret = ctx.clientSecret;
    }
  }

  const body = buildTokenBody(params, ctx.tokenContentType);

  let response: Response;
  try {
    response = await fetch(ctx.tokenUrl, {
      method: "POST",
      headers: buildTokenHeaders(
        ctx.tokenAuthMethod,
        ctx.clientId ?? "",
        ctx.clientSecret ?? "",
        ctx.tokenContentType,
      ),
      body,
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    throw new PasswordGrantError(
      `Password grant network error for '${ctx.providerId}': ${extractErrorMessage(err)}`,
      "transient",
      ctx.providerId,
    );
  }

  if (!response.ok) {
    const text = await response.text();
    const classification = parseTokenErrorResponse(response.status, text);
    // Don't concatenate the raw IdP body into the error message — some
    // IdPs echo the rejected `username` (or other fields) back into 400
    // bodies, so a generic catcher logging `err.message` would surface
    // them. Callers needing diagnostics read the typed `body` field.
    const summary =
      classification.error !== undefined
        ? `${classification.error}${classification.errorDescription ? ` — ${classification.errorDescription}` : ""}`
        : `HTTP ${response.status}`;
    throw new PasswordGrantError(
      `Password grant failed for '${ctx.providerId}': ${summary}`,
      classification.kind,
      ctx.providerId,
      response.status,
      text,
      classification.error,
      classification.errorDescription,
    );
  }

  let tokenData: Record<string, unknown>;
  try {
    tokenData = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new PasswordGrantError(
      `Password grant returned non-JSON response for '${ctx.providerId}'`,
      "transient",
      ctx.providerId,
    );
  }

  return parseTokenResponse(tokenData);
}

/**
 * Exchange username + password for an access token (RFC 6749 §4.3).
 *
 * The username and password are sent only to the configured `tokenUrl` and
 * never persisted in the grant module itself — the caller is responsible
 * for storing them encrypted alongside the resulting tokens so the next
 * bootstrap (after the refresh_token expires) can succeed without
 * prompting the user again.
 *
 * @throws {PasswordGrantError} On any non-2xx response, network failure,
 * or non-JSON body. The `kind` field discriminates revocation
 * (`"revoked"`, i.e. wrong username/password) from transient failure.
 */
export async function exchangePasswordGrant(
  ctx: PasswordGrantContext,
  username: string,
  password: string,
): Promise<ParsedTokenResponse> {
  return postTokenRequest(ctx, {
    grant_type: "password",
    username,
    password,
  });
}

/**
 * Refresh a password-grant access token using its `refresh_token`
 * (RFC 6749 §6).
 *
 * The grant type at the token endpoint is `refresh_token` — the upstream
 * doesn't care whether the original grant was authorization_code or
 * password. The only ROPC-specific path is the **re-bootstrap fallback**:
 * if this call fails with `kind: "revoked"`, the caller should fall back
 * to {@link exchangePasswordGrant} using the stored username/password
 * before flagging the connection.
 *
 * @throws {PasswordGrantError} On any non-2xx / network / non-JSON
 * response. Caller MUST inspect `kind` to decide whether to re-bootstrap
 * or surface a hard failure.
 */
export async function refreshPasswordGrantToken(
  ctx: PasswordGrantContext,
  refreshToken: string,
): Promise<ParsedTokenResponse> {
  return postTokenRequest(ctx, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}
