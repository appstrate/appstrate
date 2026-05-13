// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal JWT-payload codec for Appstrate modules.
 *
 * Unsigned decode + unsigned encode of the standard
 * `<header>.<payload>.<signature>` three-segment shape. Used by OAuth
 * model-provider modules that need to extract identity claims from
 * provider-issued access tokens or build SDK-compatible placeholder
 * tokens that the in-container LLM client can parse.
 *
 * Does NOT verify signatures — the runtime trusts that the OAuth dance
 * produced the token; downstream upstream backends verify server-side.
 * For signature verification, use `jose` (already a transitive dep
 * via the OIDC module).
 */

function stripTrailing(input: string, char: string): string {
  let end = input.length;
  while (end > 0 && input[end - 1] === char) end--;
  return input.slice(0, end);
}

/** Base64url (URL-safe, no padding) encode of a UTF-8 string. */
export function base64UrlEncode(input: string): string {
  const b64 = Buffer.from(input, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return stripTrailing(b64, "=");
}

/** Base64url decode to a UTF-8 string. Pads automatically. */
export function base64UrlDecode(input: string): string {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

/**
 * Decode a JWT's payload segment (the middle part). Returns the parsed
 * object, or `null` when the token isn't a well-formed three-segment JWT
 * or the payload isn't a JSON object.
 *
 * Does not verify the signature — callers responsible for trusting the
 * source. See module-level comment.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const parsed = JSON.parse(base64UrlDecode(parts[1]!));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
