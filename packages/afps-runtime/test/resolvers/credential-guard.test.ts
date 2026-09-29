// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { credentialUrlPolicy } from "../../src/resolvers/credential-guard.ts";
import { substituteVars } from "../../src/resolvers/template-vars.ts";

const fields = { api_key: "SECRET" };
const allowAll = { fields, allowAllUris: true, authorizedUris: [] as string[] };

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
    expect(policy).toEqual({
      substitutesCredential: false,
      allowAllUris: true,
      authorizedUris: [],
      refuse: false,
    });
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
    });
    expect(policy.authorizedUris).toEqual(["https://api.example.com/**"]);
    expect(policy.allowAllUris).toBe(false);
    expect(policy.refuse).toBe(false);
  });

  it("drops allow_all_uris and enforces the declared allowlist", () => {
    const policy = credentialUrlPolicy({
      templates: ["{{api_key}}"],
      fields,
      allowAllUris: true,
      authorizedUris: ["https://api.example.com/**"],
    });
    expect(policy).toEqual({
      substitutesCredential: true,
      allowAllUris: false,
      authorizedUris: ["https://api.example.com/**"],
      refuse: false,
    });
  });

  it("refuses when a credential is templated and no allowlist remains", () => {
    const policy = credentialUrlPolicy({ ...allowAll, templates: ["x={{api_key}}"] });
    expect(policy.allowAllUris).toBe(false);
    expect(policy.refuse).toBe(true);
  });
});

describe("credentialUrlPolicy — URL-valued credential fields", () => {
  const fields = { webhook_url: "https://hooks.example.com/services/TVICTIM/x", secret: "S" };

  it("never widens the allowlist from a field's value (shared origins)", () => {
    const policy = credentialUrlPolicy({
      fields,
      allowAllUris: false,
      authorizedUris: ["https://api.example.com/**"],
      templates: ["{{webhook_url}}"],
    });
    expect(policy.authorizedUris).toEqual(["https://api.example.com/**"]);
  });

  it("refuses under allow_all_uris with no allowlist, the field's origin included", () => {
    const policy = credentialUrlPolicy({
      fields,
      allowAllUris: true,
      authorizedUris: [],
      templates: ["{{secret}}"],
    });
    expect(policy.authorizedUris).toEqual([]);
    expect(policy.refuse).toBe(true);
  });
});
