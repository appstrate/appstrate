// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth2 authorization-code exchange for the integration OAuth flow
 * (`handleIntegrationOAuthCallback`).
 *
 * Centralises the five error branches (network failure, non-OK response,
 * `invalid_grant` revocation, non-JSON body, missing `access_token`) and
 * the post-revoke state hygiene. Without this helper, the two paths
 * could drift on how they classify token errors — a real security
 * concern because misclassifying a transient failure as `"revoked"`
 * would force unnecessary reconnects, and misclassifying a revoked
 * token as `"transient"` would let a dead refresh-token linger.
 */

import { OAuthCallbackError } from "./oauth.ts";
import {
  buildTokenBody,
  buildTokenHeaders,
  parseTokenErrorResponse,
  parseTokenResponse,
  type ParsedTokenResponse,
} from "./token-utils.ts";
import type { OAuthStateStore, TokenEndpointAuthMethod } from "./types.ts";
import type { OAuthTokenContentType } from "./token-utils.ts";
import { getErrorMessage } from "@appstrate/core/errors";

/**
 * The token-endpoint auth methods this exchange helper implements — a narrowed
 * subset of `OAuthTokenAuthMethod` (`@appstrate/core/validation`). `"none"` is
 * the public-client case (no client_secret); the canonical enum's JWT / mTLS
 * methods are intentionally unsupported here.
 *
 * Alias of the canonical {@link TokenEndpointAuthMethod} (`./types.ts`) — the
 * single source of truth for this union across the connect surface.
 */
export type TokenExchangeAuthMethod = TokenEndpointAuthMethod;

export interface ExchangeAuthorizationCodeInput {
  /** Token endpoint URL (`auths.{key}.token_endpoint`). */
  tokenEndpoint: string;
  /** OAuth client id. Required (even for `none` — sent in the body). */
  clientId: string;
  /**
   * OAuth client secret. Empty string for public clients
   * (`tokenEndpointAuthMethod === "none"`); ignored when basic-auth is used (sent via header).
   */
  clientSecret: string;
  /** Token endpoint client-auth method (`token_endpoint_auth_method`). */
  tokenEndpointAuthMethod: TokenExchangeAuthMethod;
  /** Body content type — defaults to `application/x-www-form-urlencoded`. */
  tokenContentType?: OAuthTokenContentType;
  /**
   * PKCE `code_verifier`. Optional so the helper stays usable for a
   * PKCE-disabled exchange; the integration OAuth flow always supplies it.
   */
  codeVerifier?: string;
  /** Redirect URI that was used in the authorize call. */
  redirectUri: string;
  /** Authorization code returned by the IdP. */
  code: string;
  /** Scopes requested at authorize time — used for shortfall/creep classification. */
  scopesRequested: string[];
  /**
   * Extra body params (e.g. RFC 8707 `resource` for integration flows).
   */
  extraTokenParams?: Record<string, string>;
  /**
   * Identifier surfaced in error messages and as `OAuthCallbackError.subjectId`.
   * For integration flows this is the sentinel `__integration__:<package>:<authKey>`.
   */
  errorLabel: string;
  /** State key — deleted on `"revoked"` classification. */
  state: string;
  /** State store for post-revoke cleanup. */
  store: OAuthStateStore;
}

export interface ExchangeAuthorizationCodeResult {
  parsed: ParsedTokenResponse;
  /** Raw JSON body of the token response — integration callers persist it for identity extraction. */
  raw: Record<string, unknown>;
}

/**
 * POST `grant_type=authorization_code` to the IdP's token endpoint and
 * classify the response.
 *
 * Throws {@link OAuthCallbackError} on:
 *   - Network failure (`kind="transient"`)
 *   - Non-OK HTTP response, classified by {@link parseTokenErrorResponse}
 *     (deletes state on `"revoked"`)
 *   - Non-JSON body (`kind="transient"`)
 *   - Missing `access_token` in body (`kind="transient"`)
 */
export async function exchangeAuthorizationCode(
  input: ExchangeAuthorizationCodeInput,
): Promise<ExchangeAuthorizationCodeResult> {
  const useBasicAuth = input.tokenEndpointAuthMethod === "client_secret_basic";
  const isPublicClient = input.tokenEndpointAuthMethod === "none";

  const tokenParams: Record<string, string> = {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    // Basic-auth carries client_id+secret in the Authorization header;
    // public clients omit the secret but still need the id in the body;
    // post-auth puts both in the body.
    ...(useBasicAuth
      ? {}
      : isPublicClient
        ? { client_id: input.clientId }
        : { client_id: input.clientId, client_secret: input.clientSecret }),
    ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}),
    ...(input.extraTokenParams ?? {}),
  };

  const tokenBody = buildTokenBody(tokenParams, input.tokenContentType);

  let response: Response;
  try {
    response = await fetch(input.tokenEndpoint, {
      method: "POST",
      headers: buildTokenHeaders(
        // "none" maps to "no auth header" — buildTokenHeaders treats
        // anything other than "client_secret_basic" as body-auth.
        input.tokenEndpointAuthMethod === "none"
          ? "client_secret_post"
          : input.tokenEndpointAuthMethod,
        input.clientId,
        input.clientSecret,
        input.tokenContentType,
      ),
      body: tokenBody,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new OAuthCallbackError(
      `Token exchange network error for '${input.errorLabel}': ${getErrorMessage(err)}`,
      "transient",
      input.errorLabel,
    );
  }

  if (!response.ok) {
    const body = await response.text();
    const classification = parseTokenErrorResponse(response.status, body);
    // Don't concatenate the raw IdP body into the error message — some
    // IdPs echo the rejected `code` back in 400 bodies, so a generic
    // catcher logging `err.message` would surface them. Callers needing
    // the body for diagnostics read it off the typed `body` field.
    const summary =
      classification.error !== undefined
        ? `${classification.error}${classification.errorDescription ? ` — ${classification.errorDescription}` : ""}`
        : `HTTP ${response.status}`;
    // The auth code is dead by the time the IdP rejects with `revoked`
    // (codes are one-shot), so the PKCE state row will never be useful
    // again. Delete it instead of letting it sit until the 10-minute
    // TTL. Errors during delete are swallowed — a stale row is a QoS
    // issue, not a security one (the code is already dead).
    if (classification.kind === "revoked") {
      try {
        await input.store.delete(input.state);
      } catch {
        /* swallowed: stale row reaped by TTL within 10 minutes */
      }
    }
    throw new OAuthCallbackError(
      `Token exchange failed for '${input.errorLabel}': ${summary}`,
      classification.kind,
      input.errorLabel,
      response.status,
      body,
      classification.error,
      classification.errorDescription,
    );
  }

  let raw: Record<string, unknown>;
  try {
    raw = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new OAuthCallbackError(
      `Token exchange returned non-JSON response for '${input.errorLabel}'`,
      "transient",
      input.errorLabel,
    );
  }

  const parsed = parseTokenResponse(raw, input.scopesRequested);
  return { parsed, raw };
}
