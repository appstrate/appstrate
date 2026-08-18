// SPDX-License-Identifier: Apache-2.0

/**
 * Diagnostic suffix for the integration OAuth callback's user-facing error page.
 *
 * The page is served on a public, session-less route, so it deliberately shows
 * a generic sentence rather than the provider's own prose. That generic
 * sentence alone, though, is indistinguishable across the two failures an
 * operator actually has to fix (a `redirect_uri` the provider does not know, a
 * client-authentication method the provider rejects) and the one they cannot
 * (a transient upstream blip) — which turns a five-minute configuration fix
 * into a log-diving session.
 *
 * The compromise is to append the machine-readable OAuth error code only. Per
 * RFC 6749 §5.2 that is a short registry token (`invalid_client`,
 * `invalid_grant`, `unauthorized_client`, …) naming the failure class; it
 * carries no credential and no account detail. The free-text
 * `error_description` is NOT surfaced here — it is provider-controlled prose
 * that some IdPs use to echo the rejected code back, and it stays on the
 * server-side log line where the operator context already is.
 */

/**
 * Shape of an OAuth error code we are willing to render. RFC 6749 §A.7-A.8
 * defines `error` as one or more NQCHAR (%x20-21 / %x23-5B / %x5D-7E), and the
 * registered values are all lowercase underscore tokens. A provider that
 * answers with something outside this shape (an HTML fragment, a sentence, a
 * 4KB blob) has stopped speaking the protocol, so we drop the value rather
 * than render it — the raw body is on the log line either way.
 */
const OAUTH_ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Normalize a provider-supplied OAuth error code, or `undefined` when it is
 * absent or not code-shaped.
 */
export function normalizeOAuthErrorCode(code: string | undefined): string | undefined {
  if (code === undefined) return undefined;
  const trimmed = code.trim();
  return OAUTH_ERROR_CODE.test(trimmed) ? trimmed : undefined;
}

/**
 * Render the parenthesized diagnostic appended to the callback error page —
 * the OAuth error code when the provider named one, else the HTTP status that
 * came back, else nothing (a network-level failure has neither).
 *
 * @param code - `error` from the token endpoint body, if any.
 * @param status - HTTP status of the token endpoint response, if any.
 */
export function oauthDiagnosticSuffix(
  code: string | undefined,
  status: number | undefined,
): string {
  const normalized = normalizeOAuthErrorCode(code);
  if (normalized) return ` (${normalized})`;
  if (status !== undefined) return ` (HTTP ${status})`;
  return "";
}
