// SPDX-License-Identifier: Apache-2.0

/**
 * PKCE helpers shared by both the legacy provider OAuth flow (`./oauth.ts`)
 * and the integration OAuth flow (`./integration-oauth.ts`). Same bytes
 * end up on the wire — keep one implementation so changes (e.g. switching
 * to WebCrypto) propagate everywhere at once.
 */

import { randomBytes, createHash } from "node:crypto";

/** Cryptographically random base64url string of `byteLength` random bytes. */
export function randomBase64Url(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

/** SHA-256 hash of `input` in base64url (PKCE `code_challenge` shape). */
export function sha256Base64Url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}
