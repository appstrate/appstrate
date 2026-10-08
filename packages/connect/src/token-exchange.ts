// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth2 authorization-code exchange for the integration OAuth flow
 * (`handleIntegrationOAuthCallback`).
 */

import { OAuthCallbackError } from "./oauth.ts";
import { oauthEgressFetch } from "./oauth-egress.ts";
import {
  buildTokenBody,
  buildTokenHeaders,
  assertClientAuthCoherent,
  parseTokenResponse,
  readTokenResponse,
  type ParsedTokenResponse,
} from "./token-utils.ts";
import type { OAuthStateStore, TokenEndpointAuthMethod } from "./types.ts";
import { getErrorMessage } from "@appstrate/core/errors";

interface ExchangeAuthorizationCodeInput {
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
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  /**
   * PKCE `code_verifier`. Optional so the helper stays usable for a
   * PKCE-disabled exchange; the integration OAuth flow always supplies it.
   */
  codeVerifier?: string;
  /** Redirect URI that was used in the authorize call. */
  redirectUri: string;
  /** Authorization code returned by the IdP. */
  code: string;
  /**
   * Scopes requested at authorize time. Used as the granted set when the token
   * response omits `scope` (RFC 6749 §5.1). The integration callback reads the
   * same signed-state value into its result's `scopesRequested`.
   */
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
  /**
   * Injectable egress fetch. Defaults to the SSRF-guarded `oauthEgressFetch`.
   * Tests inject a stub here rather than patching the global `fetch` — the
   * guarded default resolves DNS, which would (correctly) fail-close on
   * non-resolvable test hostnames.
   */
  fetchImpl?: typeof fetch;
}

interface ExchangeAuthorizationCodeResult {
  parsed: ParsedTokenResponse;
  /** Raw JSON body of the token response — integration callers persist it for identity extraction. */
  raw: Record<string, unknown>;
}

/**
 * POST `grant_type=authorization_code` to the IdP's token endpoint and
 * classify the response.
 *
 * Throws {@link OAuthCallbackError} on a network failure (`kind="transient"`)
 * and on every response {@link readTokenResponse} classifies as a failure.
 * State is deleted on every `"revoked"` classification.
 */
export async function exchangeAuthorizationCode(
  input: ExchangeAuthorizationCodeInput,
): Promise<ExchangeAuthorizationCodeResult> {
  const authMethod = input.tokenEndpointAuthMethod ?? "client_secret_basic";
  // The caller resolves the method and the secret together; a pair that
  // disagrees is a bug, not a state to smooth over. See
  // `assertClientAuthCoherent`.
  assertClientAuthCoherent(authMethod, input.clientSecret, input.errorLabel);
  const useBasicAuth = authMethod === "client_secret_basic";
  const isPublicClient = authMethod === "none";

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

  const tokenBody = buildTokenBody(tokenParams);

  let response: Response;
  try {
    // SSRF-guarded: this POST carries client_secret. A blocked host throws
    // SsrfBlockedError (caught below and surfaced as a `transient` failure —
    // the classification summary in the message, never the secret body).
    const doFetch = input.fetchImpl ?? oauthEgressFetch;
    response = await doFetch(input.tokenEndpoint, {
      method: "POST",
      headers: buildTokenHeaders(authMethod, input.clientId, input.clientSecret),
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

  const read = await readTokenResponse(response);
  if (!read.ok) {
    // An auth code is one-shot, so once `revoked` its PKCE state row is never
    // useful again. A stale row is a QoS issue, not a security one.
    if (read.kind === "revoked") {
      try {
        await input.store.delete(input.state);
      } catch {
        /* swallowed: stale row reaped by TTL within 10 minutes */
      }
    }
    throw new OAuthCallbackError(
      `Token exchange failed for '${input.errorLabel}': ${read.summary}`,
      read.kind,
      input.errorLabel,
      read.status,
      read.body,
      read.error,
      read.errorDescription,
      read.cause === undefined ? undefined : { cause: read.cause },
    );
  }

  const parsed = parseTokenResponse(read.raw, input.scopesRequested);
  return { parsed, raw: read.raw };
}
