// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `maskCredentialLabel` — the structural picker that turns a
 * single-secret credential bag into a masked fingerprint label, and refuses
 * to label ambiguous multi-secret or never-show (password) fields.
 */

import { describe, it, expect } from "bun:test";
import { fingerprintSecret, maskCredentialLabel } from "../../src/services/connect/mask-label.ts";

describe("fingerprintSecret", () => {
  it("masks the middle, keeping 2-char prefix + last 4", () => {
    expect(fingerprintSecret("fc-abcdef01f10b")).toBe("fc****f10b");
  });

  it("returns undefined for values shorter than 8 chars", () => {
    expect(fingerprintSecret("short")).toBeUndefined();
    expect(fingerprintSecret("1234567")).toBeUndefined();
    expect(fingerprintSecret("12345678")).toBe("12****5678");
  });

  it("returns undefined for non-strings", () => {
    expect(fingerprintSecret(undefined)).toBeUndefined();
    expect(fingerprintSecret(42)).toBeUndefined();
    expect(fingerprintSecret(null)).toBeUndefined();
  });
});

describe("maskCredentialLabel", () => {
  it("masks the sole string secret of a single-field schema", () => {
    const schema = {
      type: "object",
      properties: { api_key: { type: "string" } },
      required: ["api_key"],
    };
    expect(maskCredentialLabel(schema, { api_key: "sk_live_abcdef12a1b2" })).toBe("sk****a1b2");
  });

  it("ignores an optional non-required field when a single required secret exists", () => {
    const schema = {
      type: "object",
      properties: {
        api_key: { type: "string" },
        base_url: { type: "string" },
      },
      required: ["api_key"],
    };
    expect(
      maskCredentialLabel(schema, { api_key: "key_abcdef12cdef", base_url: "https://x" }),
    ).toBe("ke****cdef");
  });

  it("returns undefined for ambiguous multi-secret schemas (Twilio)", () => {
    const schema = {
      type: "object",
      properties: {
        account_sid: { type: "string" },
        auth_token: { type: "string" },
      },
      required: ["account_sid", "auth_token"],
    };
    expect(
      maskCredentialLabel(schema, { account_sid: "ACxxxxxxxxxxxx", auth_token: "toktoktoktok" }),
    ).toBeUndefined();
  });

  it("excludes format:password fields (never-show class)", () => {
    const schema = {
      type: "object",
      properties: {
        email: { type: "string" },
        password: { type: "string", format: "password" },
      },
      required: ["email", "password"],
    };
    // password dropped → only `email` remains → single candidate masked.
    expect(
      maskCredentialLabel(schema, { email: "user@example.com", password: "hunter2hunter" }),
    ).toBe("us****.com");
  });

  it("returns undefined when the sole field is writeOnly", () => {
    const schema = {
      type: "object",
      properties: { password: { type: "string", writeOnly: true } },
      required: ["password"],
    };
    expect(maskCredentialLabel(schema, { password: "supersecretvalue" })).toBeUndefined();
  });

  it('handles union string types ["string","null"]', () => {
    const schema = {
      type: "object",
      properties: { token: { type: ["string", "null"] } },
      required: ["token"],
    };
    expect(maskCredentialLabel(schema, { token: "tok_abcdef12wxyz" })).toBe("to****wxyz");
  });

  it("returns undefined when the secret value is too short to fingerprint", () => {
    const schema = {
      type: "object",
      properties: { api_key: { type: "string" } },
      required: ["api_key"],
    };
    expect(maskCredentialLabel(schema, { api_key: "abc" })).toBeUndefined();
  });

  it("returns undefined for a missing/empty schema", () => {
    expect(maskCredentialLabel(undefined, { api_key: "whatever_long_value" })).toBeUndefined();
    expect(
      maskCredentialLabel({ type: "object" }, { api_key: "whatever_long_value" }),
    ).toBeUndefined();
  });

  it("falls back to all string fields when no required array is present", () => {
    const schema = {
      type: "object",
      properties: { api_key: { type: "string" } },
    };
    expect(maskCredentialLabel(schema, { api_key: "key_abcdef12ghij" })).toBe("ke****ghij");
  });
});
