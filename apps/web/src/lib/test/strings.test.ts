// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { toCredentialKey, toLiveCredentialKey } from "../strings";
import { CREDENTIAL_KEY_RE } from "@appstrate/core/validation";

describe("toCredentialKey", () => {
  it("preserves already-canonical keys", () => {
    expect(toCredentialKey("api_key")).toBe("api_key");
    expect(toCredentialKey("token")).toBe("token");
  });

  it("hyphens become underscores", () => {
    expect(toCredentialKey("api-key")).toBe("api_key");
  });

  it("lowercases uppercase input", () => {
    expect(toCredentialKey("Api-Key")).toBe("api_key");
  });

  it("strips leading digits so output matches CREDENTIAL_KEY_RE", () => {
    const out = toCredentialKey("1password");
    expect(out).toBe("password");
    expect(CREDENTIAL_KEY_RE.test(out)).toBe(true);
  });

  it("strips leading underscores produced by non-letter prefixes", () => {
    const out = toCredentialKey("--api-key");
    expect(out).toBe("api_key");
    expect(CREDENTIAL_KEY_RE.test(out)).toBe(true);
  });

  it("returns empty string when input has no letters at all", () => {
    expect(toCredentialKey("1234")).toBe("");
    expect(toCredentialKey("___")).toBe("");
  });

  it("output is always empty or a valid CREDENTIAL_KEY_RE match", () => {
    for (const sample of ["1abc", "9_token", "API-Key", "a", "a1_b", "__foo__", "é@key"]) {
      const out = toCredentialKey(sample);
      if (out !== "") {
        expect(CREDENTIAL_KEY_RE.test(out)).toBe(true);
      }
    }
  });
});

describe("toLiveCredentialKey", () => {
  it("preserves trailing underscores during typing", () => {
    expect(toLiveCredentialKey("api_")).toBe("api_");
  });

  it("strips leading digits so prefix matches CREDENTIAL_KEY_RE", () => {
    expect(toLiveCredentialKey("1key")).toBe("key");
  });
});
