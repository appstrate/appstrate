// SPDX-License-Identifier: Apache-2.0

/**
 * Shared token utilities.
 * Used by both token-exchange.ts (initial token exchange) and token-refresh.ts (refresh flow).
 *
 * `OAuthTokenAuthMethod` (= AFPS `token_endpoint_auth_method`) is the single
 * source of truth in @appstrate/core/validation.
 */

import type { OAuthTokenAuthMethod } from "@appstrate/core/validation";
import { MAX_TOKEN_BODY_BYTES, parseJsonUnder, readTextUnder } from "./bounded-body.ts";

function formUrlEncode(value: string): string {
  return new URLSearchParams([["", value]]).toString().slice(1);
}

/**
 * Build headers for an OAuth2 token endpoint request.
 * When tokenAuthMethod is "client_secret_basic", credentials are sent
 * as an Authorization: Basic header (RFC 6749 §2.3.1) instead of POST body.
 */
export function buildTokenHeaders(
  tokenAuthMethod: OAuthTokenAuthMethod | undefined,
  clientId: string,
  clientSecret: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (tokenAuthMethod === "client_secret_basic") {
    // RFC 6749 §2.3.1: each credential is form-urlencoded (Appendix B), leaving ASCII for `btoa`.
    headers["Authorization"] =
      `Basic ${btoa(`${formUrlEncode(clientId)}:${formUrlEncode(clientSecret)}`)}`;
  }
  return headers;
}

/**
 * Build the token request body (standard form-urlencoded).
 */
export function buildTokenBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

export interface ParsedTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string | null;
  /** `null` when the response omits `scope`: unchanged (RFC 6749 §5.1), never "no scopes". */
  scopesReturned: string[] | null;
}

/**
 * Classified outcome of an OAuth2 token endpoint response that yielded no
 * access token: a non-2xx, or a 2xx whose JSON body carries an RFC 6749 §5.2
 * error object (some IdPs answer `200 {"error":"invalid_grant"}`).
 *
 * A dead authorization code or refresh token is signaled by
 * `{ "error": "invalid_grant" }` (RFC 6749 §5.2). Any other failure (network,
 * 5xx, non-JSON body, other 4xx, other OAuth error codes, a 2xx with neither
 * `access_token` nor `error`) is treated as transient because the credential
 * might still be valid — except a refused client (`"client_rejected"`).
 *
 * Both the initial token exchange (token-exchange.ts) and the refresh flow
 * (token-refresh.ts) read the response through {@link readTokenResponse} so
 * that revocation handling stays symmetric.
 */
export type TokenErrorKind = "revoked" | "client_rejected" | "transient";

const CLIENT_REJECTED_ERRORS: ReadonlySet<string> = new Set([
  "invalid_client",
  "unauthorized_client",
]);

interface TokenErrorClassification {
  kind: TokenErrorKind;
  /** OAuth2 error code from the response body (e.g. "invalid_grant") if parseable. */
  error?: string;
  /** Redacted human-readable description from the response body if present. */
  errorDescription?: string;
}

/**
 * Redact a provider-supplied OAuth2 `error_description` before it can flow
 * into an `Error.message` a logger or UI might surface.
 *
 * RFC 6749 §5.2 `error_description` is free text, but several IdPs echo the
 * rejected authorization code / refresh token back inside it — and the
 * failure summary of {@link readTokenResponse} folds this field into the
 * thrown error's `message`. This strips long unbroken credential-like runs
 * (≥20 chars of the token / JWT / base64url / hex alphabet) to `[redacted]`
 * and caps the overall length.
 */
const CREDENTIAL_LIKE_RUN = /[A-Za-z0-9._~+/=-]{20,}/g;
const MAX_ERROR_DESCRIPTION_LEN = 200;

function redactErrorDescription(description: string): string {
  const stripped = description.replace(CREDENTIAL_LIKE_RUN, "[redacted]");
  return stripped.length > MAX_ERROR_DESCRIPTION_LEN
    ? `${stripped.slice(0, MAX_ERROR_DESCRIPTION_LEN)}…`
    : stripped;
}

/**
 * Classify a parsed token endpoint body as an RFC 6749 §5.2 error object.
 *
 * Only `invalid_grant` maps to `"revoked"` — a dead authorization code or
 * refresh token, where retrying is pointless and the stored PKCE state should
 * be dropped. `invalid_client` / `unauthorized_client` map to `"client_rejected"`:
 * the grant is untouched, only fixing the client registration helps. Any other
 * code or a body with no string `error` stays `"transient"`: an ambiguous signal
 * never declares a credential dead.
 *
 * `error_description` is redacted here, at the source, so every consumer that
 * folds it into `Error.message` gets the sanitized value.
 */
export function classifyTokenErrorBody(body: unknown): TokenErrorClassification {
  if (!body || typeof body !== "object") {
    return { kind: "transient" };
  }
  const parsed = body as { error?: unknown; error_description?: unknown };
  const error = typeof parsed.error === "string" ? parsed.error : undefined;
  const errorDescription =
    typeof parsed.error_description === "string"
      ? redactErrorDescription(parsed.error_description)
      : undefined;
  const kind: TokenErrorKind =
    error === "invalid_grant"
      ? "revoked"
      : error !== undefined && CLIENT_REJECTED_ERRORS.has(error)
        ? "client_rejected"
        : "transient";
  return { kind, error, errorDescription };
}

/**
 * Classify a non-2xx response from an OAuth2 token endpoint.
 *
 * Both 400 and 401 bodies are parsed. RFC 6749 §5.2 lets an authorization
 * server answer `invalid_client` with EITHER status ("If the client attempted
 * to authenticate via the Authorization request header field, the
 * authorization server MUST respond with an HTTP 401"), and providers split
 * roughly evenly on which they pick — and a wrong `token_endpoint_auth_method`
 * in a manifest surfaces exactly as `invalid_client`, which an operator needs
 * named. Other statuses (5xx, 403, …) are `"transient"` without parsing.
 *
 * @param status - HTTP status code of the response
 * @param body - Raw response body (text)
 */
export function parseTokenErrorResponse(status: number, body: string): TokenErrorClassification {
  if (status !== 400 && status !== 401) {
    return { kind: "transient" };
  }
  try {
    return classifyTokenErrorBody(JSON.parse(body));
  } catch {
    return { kind: "transient" };
  }
}

/** A token endpoint body that carries a non-empty string `access_token`. */
type TokenResponseBody = Record<string, unknown> & { access_token: string };

/** A token endpoint response that yielded no access token, ready for the caller's error class. */
interface TokenResponseFailure extends TokenErrorClassification {
  ok: false;
  status: number;
  /**
   * The OAuth error code plus its redacted description, or a fallback naming
   * the case (`non-JSON response` covers a 2xx body past the cap too).
   */
  summary: string;
  /**
   * The body as received (non-2xx, JSON or not) or re-serialized (2xx JSON);
   * absent when a 2xx body is not JSON or is past the cap.
   */
  body?: string;
  /**
   * Why a 2xx body could not be read: the `SyntaxError` of a non-JSON body or
   * the `RangeError` of the size cap. The read consumed the stream, so it is
   * all that is left of what came back.
   */
  cause?: unknown;
}

type TokenResponseRead = { ok: true; raw: TokenResponseBody } | TokenResponseFailure;

function hasAccessToken(tokenData: unknown): tokenData is TokenResponseBody {
  const accessToken = (tokenData as { access_token?: unknown } | null)?.access_token;
  return typeof accessToken === "string" && accessToken !== "";
}

function classifiedFailure(
  classification: TokenErrorClassification,
  status: number,
  body: string,
  fallback: string,
): TokenResponseFailure {
  const { error, errorDescription } = classification;
  let summary = fallback;
  if (error !== undefined) summary = errorDescription ? `${error} — ${errorDescription}` : error;
  return { ok: false, ...classification, status, summary, body };
}

/**
 * Read an OAuth2 token endpoint response (under {@link MAX_TOKEN_BODY_BYTES})
 * and classify every way it can fail to carry an access token:
 *
 *   - a non-2xx, classified by {@link parseTokenErrorResponse};
 *   - a 2xx whose body is not JSON (or is past the cap): `"transient"`, the
 *     parse error as `cause`;
 *   - a 2xx JSON body without `access_token`, classified by
 *     {@link classifyTokenErrorBody}. It is a failed grant, never a success:
 *     some IdPs answer one with a 2xx RFC 6749 §5.2 error object
 *     (`200 {"error":"invalid_grant"}`, GitHub's `bad_refresh_token`).
 *
 * The failure's `summary` is the only part meant for `Error.message`: it never
 * holds the raw body, because IdPs echo the rejected code or token back in
 * error bodies and a generic catcher logs `err.message`. The raw body rides on
 * `body`, for the caller's typed error field.
 */
export async function readTokenResponse(response: Response): Promise<TokenResponseRead> {
  const { status } = response;
  if (!response.ok) {
    const body = (await readTextUnder(response, MAX_TOKEN_BODY_BYTES)) ?? "";
    return classifiedFailure(parseTokenErrorResponse(status, body), status, body, `HTTP ${status}`);
  }
  let raw: unknown;
  try {
    raw = await parseJsonUnder(response, MAX_TOKEN_BODY_BYTES);
  } catch (cause) {
    return { ok: false, kind: "transient", status, summary: "non-JSON response", cause };
  }
  if (hasAccessToken(raw)) return { ok: true, raw };
  return classifiedFailure(
    classifyTokenErrorBody(raw),
    status,
    JSON.stringify(raw),
    `HTTP ${status} without access_token`,
  );
}

/**
 * Parse a standard OAuth2 token endpoint response.
 *
 * Scope parsing is universal: splits by comma, space, or %20 to handle all
 * provider conventions (e.g. GitHub returns comma-separated, Google uses spaces).
 *
 * Scope comparison against the request is not done here: it needs the
 * manifest's `scope_catalog[].implies` aliases (e.g. Google echoing `email` as
 * `…/auth/userinfo.email`), which only the platform layer knows.
 *
 * @param tokenData - Token endpoint body, as narrowed by {@link readTokenResponse}
 * @param fallbackRefreshToken - Refresh token to preserve if not present in response
 */
export function parseTokenResponse(
  tokenData: TokenResponseBody,
  fallbackRefreshToken?: string,
): ParsedTokenResponse {
  const accessToken = tokenData.access_token;

  const refreshToken =
    typeof tokenData.refresh_token === "string" ? tokenData.refresh_token : fallbackRefreshToken;

  // Some IdPs (Azure AD v1, certain Keycloak configs) serialize `expires_in`
  // as a JSON string ("3600"). Coerce so the proactive lead-window refresh
  // still fires — a strict `typeof === "number"` check would drop it and
  // leave `expiresAt: null` (token treated as never-expiring).
  let expiresAt: string | null = null;
  const expiresIn =
    typeof tokenData.expires_in === "number"
      ? tokenData.expires_in
      : typeof tokenData.expires_in === "string"
        ? Number(tokenData.expires_in)
        : NaN;
  if (Number.isFinite(expiresIn)) {
    expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  }

  const scopes =
    typeof tokenData.scope === "string" ? tokenData.scope.split(/[\s,]+|%20/).filter(Boolean) : [];

  return {
    accessToken,
    refreshToken,
    expiresAt,
    scopesReturned: scopes.length > 0 ? scopes : null,
  };
}

/**
 * A client-authentication pair that cannot be correct — thrown by
 * {@link assertClientAuthCoherent}.
 *
 * A distinct type: the refresh path counts only a `RefreshError` toward the
 * `needs_reconnection` streak, so a configuration fault never spends it.
 */
export class ClientAuthInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientAuthInvariantError";
  }
}

/**
 * Refuse to build a token request whose client-authentication method and
 * secret contradict each other, in EITHER direction.
 *
 * `client_secret_post` / `client_secret_basic` mean the client HAS a password
 * (RFC 6749 §2.3); a client without one authenticates by `client_id` alone,
 * which is `token_endpoint_auth_method: "none"` (RFC 7591 §2). So:
 *
 *   - a secret-based method with no secret is a request that cannot succeed —
 *     it is how `client_secret=` (present but empty) reached providers that
 *     reject it: Dropbox answered `invalid_client` while Airtable tolerated
 *     the equivalent empty Basic header, so one integration silently worked
 *     and another hard-failed on the same misconfiguration;
 *   - `"none"` WITH a secret is the mirror fault: a caller that resolved a
 *     credential and then declared it would not be used. The secret would be
 *     silently dropped on the wire, which is how a confidential client gets
 *     quietly downgraded to a public one.
 *
 * Callers resolve the pair together — `resolveIntegrationClientById` and
 * `resolveConnectClient` return the method alongside the credentials it
 * belongs to — so reaching this throw means a caller built the pair itself and
 * got it wrong. Loud beats a silent downgrade: a downgrade would paper over
 * exactly the kind of drift this exists to surface.
 */
export function assertClientAuthCoherent(
  method: OAuthTokenAuthMethod | undefined,
  clientSecret: string | undefined,
  label: string,
): void {
  if (method === "none") {
    if (!clientSecret) return;
    throw new ClientAuthInvariantError(
      `${label}: token_endpoint_auth_method='none' declares a public client, but a client_secret ` +
        `was resolved. Sending it would be ignored and dropping it silently would downgrade a ` +
        `confidential client — resolve the method and the secret together.`,
    );
  }
  if (method === undefined || clientSecret) return;
  throw new ClientAuthInvariantError(
    `${label}: token_endpoint_auth_method='${method}' requires a client_secret, but none was ` +
      `resolved. A client registered without a secret is a public client and must be resolved ` +
      `as token_endpoint_auth_method='none'.`,
  );
}
