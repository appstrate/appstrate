// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { credentialUrlPolicy } from "../../src/resolvers/credential-guard.ts";
import { matchesAuthorizedUri } from "../../src/resolvers/api-call-engine.ts";
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
  it("keeps the declared policy, unaugmented, when nothing is templated", () => {
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

describe("credentialUrlPolicy — credential-field origins", () => {
  const webhook = {
    fields: { webhook_url: "https://hooks.example.com/x/y", secret_header_value: "S" },
    allowAllUris: true,
    authorizedUris: [] as string[],
  };

  it("adds the origin of a URL-valued field, which then matches the templated target", () => {
    const policy = credentialUrlPolicy({
      ...webhook,
      templates: ["{{webhook_url}}", "{{secret_header_value}}"],
    });
    expect(policy.authorizedUris).toEqual(["https://hooks.example.com/**"]);
    expect(policy.refuse).toBe(false);
    const target = substituteVars("{{webhook_url}}", webhook.fields);
    expect(matchesAuthorizedUri(target, policy.authorizedUris)).toBe(true);
  });

  it("does not match a `{{site_url}}@evil.example` target (userinfo, real host evil)", () => {
    const site = { site_url: "https://shop.example.com" };
    const policy = credentialUrlPolicy({
      fields: site,
      allowAllUris: true,
      authorizedUris: [],
      templates: ["{{site_url}}@evil.example/wp-json"],
    });
    expect(policy.authorizedUris).toEqual(["https://shop.example.com/**"]);
    const target = substituteVars("{{site_url}}@evil.example/wp-json", site);
    expect(new URL(target).hostname).toBe("evil.example");
    expect(matchesAuthorizedUri(target, policy.authorizedUris)).toBe(false);
  });

  it("ignores non-URL, relative and non-http(s) field values", () => {
    const policy = credentialUrlPolicy({
      fields: {
        api_key: "SECRET",
        path: "/wp-json/v2",
        rel: "hooks.example.com/x",
        js: "javascript:alert(1)",
        ftp: "ftp://files.example.com/",
      },
      allowAllUris: true,
      authorizedUris: [],
      templates: ["{{api_key}}"],
    });
    expect(policy.authorizedUris).toEqual([]);
    expect(policy.refuse).toBe(true);
  });

  it("appends field origins to a declared allowlist without duplicates", () => {
    const policy = credentialUrlPolicy({
      fields: { a: "https://hooks.example.com/1", b: "https://hooks.example.com/2" },
      allowAllUris: false,
      authorizedUris: ["https://api.example.com/**"],
      templates: ["{{a}}"],
    });
    expect(policy.authorizedUris).toEqual([
      "https://api.example.com/**",
      "https://hooks.example.com/**",
    ]);
  });
});
