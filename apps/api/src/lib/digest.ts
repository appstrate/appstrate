// SPDX-License-Identifier: Apache-2.0

/**
 * SHA-256 digest encodings shared across the upload-integrity and
 * content-download paths.
 */

/** A lowercase 64-char hex SHA-256 digest. */
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Convert a hex-encoded SHA-256 digest to its standard base64 form (the wire
 * shape S3's `x-amz-checksum-sha256` header and RFC 9530's `Repr-Digest`
 * `sha-256=:…:` both use). Rejects anything that is not exactly 64 hex chars so
 * a caller can never sign a truncated / malformed checksum. Case-insensitive on
 * input; callers should have normalized to lowercase already.
 */
export function sha256HexToBase64(hex: string): string {
  if (!SHA256_HEX_RE.test(hex.toLowerCase())) {
    throw new Error("expected a 64-character hex SHA-256 digest");
  }
  return Buffer.from(hex, "hex").toString("base64");
}

/**
 * RFC 9530 `Repr-Digest` field value for a SHA-256 digest given in hex:
 * `sha-256=:<base64>:`. One builder so the download path emits the exact
 * structured-field syntax (the digest is wrapped in colons as a byte-sequence
 * member).
 */
export function reprDigestSha256(hex: string): string {
  return `sha-256=:${sha256HexToBase64(hex)}:`;
}
