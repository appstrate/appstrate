// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 8707 — Resource Indicators for OAuth 2.0.
 *
 * Mandated by the MCP November-2025 authorization spec for HTTP-transport
 * MCP servers and reused here for upstream API audience binding in AFPS
 * integrations (proposal §4.1.1, `auths.{key}.audience`).
 *
 * Semantics:
 *
 *   - The runtime sends `resource=<audience>` (URL-encoded, repeatable)
 *     alongside `/authorize`, `/token` and refresh requests so the
 *     authorization server can bind the issued access token to that
 *     specific upstream API.
 *
 *   - When the AS supports RFC 8707, it issues a narrowly-scoped token
 *     (or accepts the parameter and silently audience-binds). When the
 *     AS does not understand `resource`, it MUST silently ignore the
 *     parameter (per RFC 8707 §2) — that's the no-op path.
 *
 *   - When the AS supports RFC 8707 but rejects the requested resource
 *     (typo, off-allowlist, scope/audience mismatch), it responds with
 *     `{ "error": "invalid_target" }` per RFC 8707 §4. Callers SHOULD
 *     surface this as a configuration error rather than a transient
 *     failure: retrying with the same audience will keep failing.
 *
 * This module is pure (no I/O, no DB) so it can be unit-tested without
 * a live AS. The actual fetch lives in `token-refresh.ts` /
 * `oauth.ts` — those modules import {@link appendResourceToTokenBody}
 * to apply the parameter at the wire boundary.
 */

/** Pre-parsed audience(s) accepted by {@link appendResourceToTokenBody}. */
export type AudienceInput = string | readonly string[] | undefined;

/**
 * Append `resource=<audience>` to an OAuth-style body (`application/x-www-form-urlencoded`).
 *
 * - Accepts either a `URLSearchParams` (mutated in place) or a plain
 *   `Record<string, string>` (returned as a new object — Map-like
 *   semantics, the input is not mutated).
 * - Multiple audiences become repeated `resource` keys per RFC 8707 §2.
 * - `undefined` / empty audience is a no-op (returns the input unchanged
 *   for `URLSearchParams`, the original record otherwise).
 *
 * Note: this function does NOT validate that `audience` is a valid URI.
 * The Zod schema in `@appstrate/core/integration` already enforces
 * `audience: string` at manifest-validation time, so by the time we get
 * here the value is trusted to be the operator-declared audience.
 */
export function appendResourceToTokenBody(
  body: URLSearchParams,
  audience: AudienceInput,
): URLSearchParams;
export function appendResourceToTokenBody(
  body: Record<string, string>,
  audience: AudienceInput,
): Record<string, string>;
export function appendResourceToTokenBody(
  body: URLSearchParams | Record<string, string>,
  audience: AudienceInput,
): URLSearchParams | Record<string, string> {
  const audiences = normalizeAudience(audience);
  if (audiences.length === 0) return body;

  if (body instanceof URLSearchParams) {
    for (const a of audiences) body.append("resource", a);
    return body;
  }

  // Plain record path: single resource collapses to `resource: <value>`,
  // multiple resources require URLSearchParams downstream (callers that
  // declare multi-resource MUST use the URLSearchParams overload).
  if (audiences.length > 1) {
    throw new TypeError(
      "appendResourceToTokenBody: multiple audiences require URLSearchParams (records cannot carry repeated keys)",
    );
  }
  return { ...body, resource: audiences[0]! };
}

/**
 * Build the `resource` query-string fragment to append to an
 * `/authorize` URL. Returns the empty string if no audience is
 * configured — callers can safely concatenate the result.
 *
 * Example: `${authorizeUrl}?${existingParams}${buildAuthorizeResourceQuery(audience)}`
 *
 * The fragment is prefixed with `&` when non-empty, on the assumption
 * that there is already at least one parameter (`client_id`, …). The
 * helper is intentionally narrow — building the full `/authorize`
 * query lives in `oauth.ts` and would couple this module to the OAuth
 * client.
 */
export function buildAuthorizeResourceQuery(audience: AudienceInput): string {
  const audiences = normalizeAudience(audience);
  if (audiences.length === 0) return "";
  return "&" + audiences.map((a) => `resource=${encodeURIComponent(a)}`).join("&");
}

/** Categorisation of an OAuth token-endpoint error response w.r.t. audience binding. */
export type AudienceResponseCategory =
  /** AS understood `resource` and accepted it (or quietly ignored it — RFC 8707 §2). */
  | "accepted-or-no-op"
  /** AS responded `{"error":"invalid_target"}` per RFC 8707 §4 — configuration error. */
  | "invalid-target"
  /** AS responded with another error (`invalid_grant`, `invalid_scope`, …). Not RFC 8707-related. */
  | "other-error";

/**
 * Minimal shape of an OAuth 2.0 error response (RFC 6749 §5.2).
 */
export interface OAuthErrorResponse {
  error?: string;
  error_description?: string;
  error_uri?: string;
}

/**
 * Categorise a parsed OAuth error body w.r.t. RFC 8707 audience binding.
 *
 * Use this after `parseTokenErrorResponse` (or your own JSON.parse) so
 * the caller knows whether to surface "you declared the wrong audience"
 * (an operator-level configuration error) versus other token errors
 * (revoked credentials, transient, etc.).
 *
 * A `null`/empty/non-error body categorises as `"accepted-or-no-op"`
 * because the AS either succeeded or returned a non-OAuth error shape
 * — both of which are RFC 8707 no-ops at this layer.
 */
export function categorizeAudienceResponse(
  body: OAuthErrorResponse | null | undefined,
): AudienceResponseCategory {
  if (!body || !body.error) return "accepted-or-no-op";
  if (body.error === "invalid_target") return "invalid-target";
  return "other-error";
}

function normalizeAudience(input: AudienceInput): string[] {
  if (input === undefined) return [];
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed.length === 0 ? [] : [trimmed];
  }
  return input.map((a) => a.trim()).filter((a) => a.length > 0);
}
