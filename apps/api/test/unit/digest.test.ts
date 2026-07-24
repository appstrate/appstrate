// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the SHA-256 digest encodings shared by the upload-integrity
 * (S3 `x-amz-checksum-sha256`) and content-download (`Repr-Digest`) paths.
 */

import { describe, it, expect } from "bun:test";
import { sha256HexToBase64, reprDigestSha256 } from "../../src/lib/digest.ts";

// SHA-256 of the empty string, and its canonical base64 form.
const EMPTY_HEX = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const EMPTY_B64 = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";

describe("sha256HexToBase64", () => {
  it("converts a known hex digest to its base64 form", () => {
    expect(sha256HexToBase64(EMPTY_HEX)).toBe(EMPTY_B64);
  });

  it("is case-insensitive on the hex input", () => {
    expect(sha256HexToBase64(EMPTY_HEX.toUpperCase())).toBe(EMPTY_B64);
  });

  it("round-trips through Buffer (base64 decodes back to the same bytes)", () => {
    const b64 = sha256HexToBase64(EMPTY_HEX);
    expect(Buffer.from(b64, "base64").toString("hex")).toBe(EMPTY_HEX);
  });

  it("rejects a non-64-char or non-hex digest", () => {
    expect(() => sha256HexToBase64("abc")).toThrow();
    expect(() => sha256HexToBase64("z".repeat(64))).toThrow();
    expect(() => sha256HexToBase64(EMPTY_HEX + "00")).toThrow();
  });
});

describe("reprDigestSha256", () => {
  it("wraps the base64 digest in RFC 9530 structured-field syntax", () => {
    expect(reprDigestSha256(EMPTY_HEX)).toBe(`sha-256=:${EMPTY_B64}:`);
  });
});
