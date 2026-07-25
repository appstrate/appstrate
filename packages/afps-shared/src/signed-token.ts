// SPDX-License-Identifier: Apache-2.0

/**
 * Keyring-HMAC capability tokens — the ONE codec behind every short-lived,
 * URL-carried capability the platform mints (filesystem/proxy upload URLs,
 * document previews, hosted connect sessions).
 *
 * Wire format: `base64url(JSON payload).base64url(HMAC-SHA256)`.
 *
 * Two properties are load-bearing and were previously re-implemented (and
 * drifted) per token type:
 *
 *  - **Keyring rotation.** A secret is a comma-separated list (or an array):
 *    the FIRST key signs new tokens, ALL keys verify, so a rotation never
 *    invalidates tokens already in flight. Individual keys must therefore not
 *    contain commas.
 *  - **Domain separation.** {@link signKeyringToken} takes the domain as its
 *    FIRST, REQUIRED argument and mixes it into the signed content, so a token
 *    minted for one purpose can never be verified as another — including when
 *    two token types share a signing secret (upload URLs and document previews
 *    both key off `UPLOAD_SIGNING_SECRET`). Making the parameter mandatory is
 *    the point: an optional domain is a domain someone forgets, and the
 *    resulting protection is one-directional — exactly the asymmetry this
 *    module replaces.
 *
 * Deliberately NOT part of the codec: expiry and claim validation. Every token
 * type names its expiry field differently and enforces its own required
 * claims, so {@link verifyKeyringToken} returns the decoded payload after the
 * signature check and leaves semantics to the caller.
 *
 * Zero-dependency leaf so `@appstrate/core` (storage), the platform API
 * (document previews) and `@appstrate/connect` (hosted connect sessions) can
 * all sit above it without a cycle.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Normalize a signing secret into a keyring. A plain string is split on commas
 * (rotation: prepend the new key); empty segments are dropped.
 */
export function toKeyring(secret: string | readonly string[]): string[] {
  const keys = typeof secret === "string" ? secret.split(",") : [...secret];
  return keys.filter((k) => k.length > 0);
}

/**
 * Encode + HMAC-sign a payload with the FIRST key of the keyring, binding the
 * signature to `domain`. Throws when the keyring holds no usable key.
 *
 * `domain` is a short, stable, versioned literal (`"doc-preview.v1."`) — change
 * it and every token already in flight stops verifying.
 */
export function signKeyringToken(
  domain: string,
  payload: unknown,
  secret: string | readonly string[],
): string {
  const [activeKey] = toKeyring(secret);
  if (!activeKey) throw new Error("signKeyringToken requires at least one signing key");
  const body = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  const sig = createHmac("sha256", activeKey)
    .update(domain + body)
    .digest("base64url");
  return `${body}.${sig}`;
}

/**
 * Verify a token against `domain` and decode its payload. Returns null on any
 * failure (malformed shape, wrong/absent signature, non-JSON body) — never
 * throws. Verifies against EVERY key of the keyring (constant-time comparison
 * per key) so tokens signed before a rotation stay valid.
 *
 * The returned value is the raw decoded JSON cast to `T`: the signature proves
 * WE minted it, not that its fields are the ones the caller expects. Callers
 * validate expiry + required claims themselves.
 */
export function verifyKeyringToken<T>(
  domain: string,
  token: string,
  secret: string | readonly string[],
): T | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const a = Buffer.from(sig);
  let valid = false;
  for (const key of toKeyring(secret)) {
    const b = Buffer.from(
      createHmac("sha256", key)
        .update(domain + body)
        .digest("base64url"),
    );
    if (a.length === b.length && timingSafeEqual(a, b)) {
      valid = true;
      break;
    }
  }
  if (!valid) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as T;
  } catch {
    return null;
  }
}
