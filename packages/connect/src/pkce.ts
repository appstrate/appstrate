// SPDX-License-Identifier: Apache-2.0

/**
 * PKCE helpers for the integration OAuth flow (`./integration-oauth.ts`).
 * One implementation so a change (e.g. switching to WebCrypto) lands in
 * one place.
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
