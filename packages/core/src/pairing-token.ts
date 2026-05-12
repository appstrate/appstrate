// SPDX-License-Identifier: Apache-2.0

/**
 * Pairing-token format used to drive the front-end-initiated OAuth
 * connection flow. The dashboard mints a token, surfaces it in a
 * `npx @appstrate/connect <token>` command, and the helper decodes it
 * client-side to discover (a) which platform host to POST credentials
 * back to and (b) which provider's OAuth dance to run.
 *
 * Token layout (URL-safe, no quoting needed in shells):
 *
 *   appp_<base64url(JSON header)>.<base64url(random secret)>
 *
 * Where the header is:
 *
 *   { "u": "<platform url>", "p": "<provider id>", "v": 1 }
 *
 * The header is **not** signed by the helper's standpoint — the platform
 * verifies the random secret server-side via a SHA-256 hash lookup. The
 * helper simply trusts the URL embedded in the token and POSTs there. A
 * tampered URL produces a non-200 (the platform at the wrong URL has no
 * matching pairing row) — failure is loud, not silent.
 *
 * The "appp_" prefix mirrors `ask_` (API key) and `pair_` (pairing row id)
 * so logs and accidental copy-pastes in chat logs are immediately
 * identifiable.
 */

const TOKEN_PREFIX = "appp_";
const HEADER_VERSION = 1;

export interface PairingTokenHeader {
  /** Base URL of the platform that minted the token (e.g. `https://app.appstrate.dev`). */
  platformUrl: string;
  /** Canonical providerId — matches the key a module registered in the platform's provider registry. */
  providerId: string;
}

export interface DecodedPairingToken extends PairingTokenHeader {
  /** Full token, including prefix — what the helper passes back as `Authorization: Bearer <token>`. */
  raw: string;
}

function stripTrailing(input: string, char: string): string {
  let end = input.length;
  while (end > 0 && input[end - 1] === char) end--;
  return input.slice(0, end);
}

function base64UrlEncode(input: string): string {
  const b64 = Buffer.from(input, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return stripTrailing(b64, "=");
}

function base64UrlDecode(input: string): string {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

function isHttpsOrLoopback(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    // Localhost / loopback only allowed over plain HTTP — for self-host dev
    // and the test suite. Anything else MUST be HTTPS so a tampered token
    // can't downgrade us into a clear-text POST that bystanders can sniff.
    if (parsed.protocol !== "http:") return false;
    const host = parsed.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}

/**
 * Build a pairing token. Called server-side at pairing creation. The
 * `secret` is what the platform stores hashed and what the helper sends
 * back as Bearer credentials.
 */
export function encodePairingToken(header: PairingTokenHeader, secret: string): string {
  if (!isHttpsOrLoopback(header.platformUrl)) {
    throw new Error(`Invalid platformUrl (must be HTTPS or loopback): ${header.platformUrl}`);
  }
  if (!header.providerId || /[^a-z0-9-]/.test(header.providerId)) {
    throw new Error(`Invalid providerId: ${header.providerId}`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(secret) || secret.length < 32) {
    throw new Error("Invalid secret (must be ≥32 url-safe chars)");
  }
  const headerJson = JSON.stringify({
    u: stripTrailing(header.platformUrl, "/"),
    p: header.providerId,
    v: HEADER_VERSION,
  });
  return `${TOKEN_PREFIX}${base64UrlEncode(headerJson)}.${secret}`;
}

/**
 * Decode a pairing token client-side. The helper calls this to discover
 * the platform URL + providerId before running the OAuth flow. The
 * server-side bearer auth re-decodes via the same function before
 * looking the row up by SHA-256(secret).
 *
 * Throws on:
 *   - missing prefix / wrong shape
 *   - tampered header (invalid JSON, missing fields, downgraded URL)
 *   - unknown header version (forward-compat: future tokens reject here)
 */
export function decodePairingToken(token: string): DecodedPairingToken {
  if (!token.startsWith(TOKEN_PREFIX)) {
    throw new Error("Invalid pairing token: missing 'appp_' prefix");
  }
  const stripped = token.slice(TOKEN_PREFIX.length);
  const dot = stripped.indexOf(".");
  if (dot <= 0 || dot === stripped.length - 1) {
    throw new Error("Invalid pairing token: malformed (header.secret expected)");
  }
  const headerB64 = stripped.slice(0, dot);
  const secret = stripped.slice(dot + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(headerB64));
  } catch {
    throw new Error("Invalid pairing token: header is not valid base64url JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid pairing token: header is not an object");
  }
  const obj = parsed as Record<string, unknown>;
  const platformUrl = typeof obj.u === "string" ? obj.u : "";
  const providerId = typeof obj.p === "string" ? obj.p : "";
  const version = typeof obj.v === "number" ? obj.v : 0;
  if (version !== HEADER_VERSION) {
    throw new Error(
      `Invalid pairing token: unsupported version ${version} (this helper supports v${HEADER_VERSION})`,
    );
  }
  if (!isHttpsOrLoopback(platformUrl)) {
    throw new Error(
      `Invalid pairing token: platformUrl must be HTTPS or loopback (got ${platformUrl})`,
    );
  }
  if (!providerId || /[^a-z0-9-]/.test(providerId)) {
    throw new Error(`Invalid pairing token: malformed providerId (${providerId})`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(secret) || secret.length < 32) {
    throw new Error("Invalid pairing token: malformed secret");
  }

  return { platformUrl, providerId, raw: token };
}

/**
 * Hash the bearer secret with SHA-256 and return base64url. Used by the
 * platform side to compare the incoming bearer against the stored
 * `tokenHash` — the plaintext is never persisted.
 */
export async function hashPairingSecret(token: string): Promise<string> {
  // Extract just the secret portion (everything after the dot in the
  // stripped form). The header is non-secret and not part of the hash
  // input — compromising it doesn't grant the holder anything new.
  if (!token.startsWith(TOKEN_PREFIX)) {
    throw new Error("Invalid pairing token: missing 'appp_' prefix");
  }
  const stripped = token.slice(TOKEN_PREFIX.length);
  const dot = stripped.indexOf(".");
  if (dot <= 0) throw new Error("Invalid pairing token: malformed");
  const secret = stripped.slice(dot + 1);
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const b64 = Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  return stripTrailing(b64, "=");
}
