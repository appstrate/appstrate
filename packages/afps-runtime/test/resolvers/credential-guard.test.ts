// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  credentialUrlPolicy,
  urlPolicyRefusalMessage,
} from "../../src/resolvers/credential-guard.ts";
import { substituteVars } from "../../src/resolvers/template-vars.ts";

const fields = { api_key: "SECRET" };
const allowAll = {
  fields,
  allowAllUris: true,
  declaredUris: [] as string[],
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
    expect(policy).toEqual({ substitutesCredential: false, allowAllUris: true, refuse: null });
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
      declaredUris: ["https://api.example.com/**"],
      authorizedUris: ["https://api.example.com/**"],
      injectsCredential: false,
    });
    expect(policy.allowAllUris).toBe(false);
    expect(policy.refuse).toBeNull();
  });

  it("drops allow_all_uris and does not refuse when an allowlist is declared", () => {
    const policy = credentialUrlPolicy({
      templates: ["{{api_key}}"],
      fields,
      allowAllUris: true,
      declaredUris: ["https://api.example.com/**"],
      authorizedUris: ["https://api.example.com/**"],
      injectsCredential: false,
    });
    expect(policy).toEqual({ substitutesCredential: true, allowAllUris: false, refuse: null });
  });

  it("refuses when a credential is templated and no allowlist remains", () => {
    const policy = credentialUrlPolicy({ ...allowAll, templates: ["x={{api_key}}"] });
    expect(policy.allowAllUris).toBe(false);
    expect(policy.refuse).toBe("exfiltration");
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
      refuse: "exfiltration",
    });
  });

  it("holds the call to an allowlist that names the host", () => {
    const policy = credentialUrlPolicy({
      ...injected,
      authorizedUris: ["https://api.example.com/**", "https://*.example.com/**"],
    });
    expect(policy).toEqual({ substitutesCredential: false, allowAllUris: false, refuse: null });
  });

  it("refuses an allowlist entry that leaves the host to the caller, templated or injected", () => {
    for (const unbounded of ["https://**", "https://*.com/**"]) {
      const authorizedUris = ["https://api.example.com/**", unbounded];
      expect(credentialUrlPolicy({ ...injected, authorizedUris }).refuse).toBe("exfiltration");
      expect(
        credentialUrlPolicy({
          ...allowAll,
          templates: ["{{api_key}}"],
          allowAllUris: false,
          authorizedUris,
        }).refuse,
      ).toBe("exfiltration");
    }
  });

  it("leaves an unbounded allowlist alone when no credential is carried", () => {
    const policy = credentialUrlPolicy({
      ...allowAll,
      templates: ["https://example.org/"],
      allowAllUris: false,
      authorizedUris: ["https://**"],
    });
    expect(policy.refuse).toBeNull();
  });
});

describe("credentialUrlPolicy — an allowlist that authorizes nothing", () => {
  const bare = { ...allowAll, templates: ["https://api.example.com/x"], allowAllUris: false };

  it("refuses every call when there is no authorized_uris and no allow_all_uris", () => {
    expect(credentialUrlPolicy(bare).refuse).toBe("unauthorized");
    expect(credentialUrlPolicy({ ...bare, allowAllUris: true }).refuse).toBeNull();
  });

  it("names the connection's URL when the declared list renders to nothing", () => {
    const policy = credentialUrlPolicy({ ...bare, declaredUris: ["{$credential.site_url}/**"] });
    expect(policy.refuse).toBe("unrendered");
    expect(urlPolicyRefusalMessage("unrendered", "@x/wp")).toContain("does not render");
  });

  it("refuses an unrendered list even when allow_all_uris is dropped for a credential", () => {
    const policy = credentialUrlPolicy({
      ...bare,
      allowAllUris: true,
      injectsCredential: true,
      declaredUris: ["{$credential.site_url}/**"],
    });
    expect(policy.refuse).toBe("unrendered");
  });

  it("calls a credential with no allowlist under allow_all_uris an exfiltration", () => {
    expect(
      credentialUrlPolicy({ ...bare, allowAllUris: true, injectsCredential: true }).refuse,
    ).toBe("exfiltration");
  });
});
