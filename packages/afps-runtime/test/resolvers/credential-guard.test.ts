// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { credentialUrlPolicy } from "../../src/resolvers/credential-guard.ts";
import { substituteVars } from "../../src/resolvers/template-vars.ts";

const fields = { api_key: "SECRET" };
const allowAll = {
  fields,
  allowAllUris: true,
  authorizedUris: [] as string[],
  injectsCredential: false,
};

describe("credentialUrlPolicy — detection", () => {
  it.each([
    ["URL", "https://evil.example/?k={{api_key}}"],
    ["header value", "Bearer {{ api_key }}"],
    ["JSON leaf with a tab inside the braces", "{{\tapi_key}}"],
    ["JSON leaf with a newline inside the braces", "{{api_key\n}}"],
  ])("detects a credential in a %s", (_, template) => {
    expect(credentialUrlPolicy({ ...allowAll, templates: [template] }).substitutesCredential).toBe(
      true,
    );
  });

  it("ignores placeholders naming no credential field, prototype names included", () => {
    const policy = credentialUrlPolicy({
      ...allowAll,
      templates: ["{{constructor}}", "{{toString}}", "{{__proto__}}", "{{other}}", "plain"],
    });
    expect(policy).toEqual({ substitutesCredential: false, allowAllUris: true, refuse: false });
  });

  it("substitution leaves a prototype-name placeholder unresolved", () => {
    expect(substituteVars("{{constructor}}", fields, { keepUnresolved: true })).toBe(
      "{{constructor}}",
    );
  });
});

describe("credentialUrlPolicy — downgrade and refusal", () => {
  it("keeps the declared policy when nothing is templated", () => {
    const policy = credentialUrlPolicy({
      templates: ["https://api.example.com/x"],
      fields: { site_url: "https://site.example.com" },
      allowAllUris: false,
      authorizedUris: ["https://api.example.com/**"],
      injectsCredential: false,
    });
    expect(policy.allowAllUris).toBe(false);
    expect(policy.refuse).toBe(false);
  });

  it("drops allow_all_uris and does not refuse when an allowlist is declared", () => {
    const policy = credentialUrlPolicy({
      templates: ["{{api_key}}"],
      fields,
      allowAllUris: true,
      authorizedUris: ["https://api.example.com/**"],
      injectsCredential: false,
    });
    expect(policy).toEqual({ substitutesCredential: true, allowAllUris: false, refuse: false });
  });

  it("refuses when a credential is templated and no allowlist remains", () => {
    const policy = credentialUrlPolicy({ ...allowAll, templates: ["x={{api_key}}"] });
    expect(policy.allowAllUris).toBe(false);
    expect(policy.refuse).toBe(true);
  });
});

describe("credentialUrlPolicy — a credential the proxy injects", () => {
  const injected = {
    ...allowAll,
    templates: ["https://api.example.com/x"],
    injectsCredential: true,
  };

  it("drops allow_all_uris and refuses when no allowlist remains", () => {
    expect(credentialUrlPolicy(injected)).toEqual({
      substitutesCredential: false,
      allowAllUris: false,
      refuse: true,
    });
  });

  it("holds the call to an allowlist that names the host", () => {
    const policy = credentialUrlPolicy({
      ...injected,
      authorizedUris: ["https://api.example.com/**", "https://*.example.com/**"],
    });
    expect(policy).toEqual({ substitutesCredential: false, allowAllUris: false, refuse: false });
  });

  it("refuses an allowlist entry that leaves the host to the caller, templated or injected", () => {
    for (const unbounded of ["https://**", "https://*.com/**"]) {
      const authorizedUris = ["https://api.example.com/**", unbounded];
      expect(credentialUrlPolicy({ ...injected, authorizedUris }).refuse).toBe(true);
      expect(
        credentialUrlPolicy({
          ...allowAll,
          templates: ["{{api_key}}"],
          allowAllUris: false,
          authorizedUris,
        }).refuse,
      ).toBe(true);
    }
  });

  it("leaves an unbounded allowlist alone when no credential is carried", () => {
    const policy = credentialUrlPolicy({
      ...allowAll,
      templates: ["https://example.org/"],
      allowAllUris: false,
      authorizedUris: ["https://**"],
    });
    expect(policy.refuse).toBe(false);
  });
});
