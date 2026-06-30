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

export function stripTrailing(input: string, char: string): string {
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
 * Build an UNSIGNED (`alg:none`) JWT carrying `payload`. The signature segment
 * is the literal `"placeholder"` — never verified. Used where a consumer needs a
 * syntactically-valid JWT only to parse local claims (e.g. the Codex CLI's boot
 * parse, or pi-ai decoding `chatgpt_account_id` off the placeholder `MODEL_API_KEY`).
 * It forges no identity: it is local-only and never transmitted to any upstream
 * that would verify it.
 */
export function buildUnsignedJwt(payload: Record<string, unknown>): string {
  return [
    base64UrlEncode(JSON.stringify({ alg: "none", typ: "JWT" })),
    base64UrlEncode(JSON.stringify(payload)),
    "placeholder",
  ].join(".");
}

/** Far-future placeholder email written into the synthetic Codex id_token. */
const CODEX_PLACEHOLDER_EMAIL = "chat@appstrate.local";

/** One year, in seconds — the `exp` window of the synthetic Codex id_token. */
const CODEX_PLACEHOLDER_EXP_WINDOW_SEC = 365 * 24 * 3600;

/**
 * Build the local-only, unsigned (`alg:none`) placeholder Codex `id_token`.
 *
 * Single source of truth for the synthetic token shape, consumed BOTH by the
 * API-side `@appstrate/module-codex` provider (as the `MODEL_API_KEY`
 * placeholder pi-ai's `openai-codex-responses` decodes for `chatgpt_account_id`)
 * AND by `@appstrate/runner-codex`'s `auth.json` builder (the `tokens.id_token`
 * the Codex CLI parses to boot). Both paths must produce a BYTE-IDENTICAL token
 * so the in-container auth state is the same regardless of entry point.
 *
 * Carries ONLY the `chatgpt_account_id` routing claim, a far-future `exp` (so
 * nothing tries to refresh it), and a placeholder `email` — no real token
 * material. It is `alg:none`, LOCAL-ONLY, and NEVER transmitted to any upstream
 * that would verify it; the genuine outbound identity is the real vended
 * `access_token` the official Codex binary sends itself.
 */
export function buildCodexPlaceholderIdToken(accountId: string, nowMs: number): string {
  return buildUnsignedJwt({
    exp: Math.floor(nowMs / 1000) + CODEX_PLACEHOLDER_EXP_WINDOW_SEC,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    email: CODEX_PLACEHOLDER_EMAIL,
  });
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
