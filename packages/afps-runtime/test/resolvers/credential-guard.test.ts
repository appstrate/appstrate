// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  isHostUnboundedUriPattern,
  matchesAuthorizedUriSpec,
} from "@appstrate/afps-shared/authorized-uris";
import {
  credentialStaysWithinBound,
  credentialUrlPolicy,
  urlPolicyRefusalMessage,
} from "../../src/resolvers/credential-guard.ts";
import { substituteVars, templateHost } from "../../src/resolvers/template-vars.ts";

const fields = { api_key: "SECRET" };
const allowAll = {
  target: "https://api.example.com/x",
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
      target: "https://api.example.com/x",
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
      target: "https://api.example.com/x",
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
    for (const unbounded of [
      "https://**",
      "https://*.com/**",
      "https://*.co.uk/**",
      "https://*.github.io/**",
      "https://@x:y@**/**",
      "https://%2A%2A\\**",
    ]) {
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

  it("holds the call to a host the connection rendered under a public suffix", () => {
    // `https://{$credential.shop_domain}/**` as rendered: a literal host, whatever its suffix.
    const policy = credentialUrlPolicy({
      ...injected,
      target: "https://mystore.myshopify.com/admin",
      declaredUris: ["https://{$credential.shop_domain}/**"],
      authorizedUris: ["https://mystore.myshopify.com/**"],
    });
    expect(policy.refuse).toBeNull();
  });

  describe("a target a wildcard reaches past its registrable domain", () => {
    const authorizedUris = ["https://*.amazonaws.com/**"];

    it.each<[string, string, boolean]>([
      ["under a regional public suffix", "https://sqs.us-east-1.amazonaws.com/q", false],
      ["under another one", "https://bedrock-runtime.us-east-1.amazonaws.com/model", false],
      ["that is itself a public suffix", "https://s3.amazonaws.com/bucket/key", false],
      ["inside the registrable domain", "https://sts.amazonaws.com/", true],
      ["inside it, in a region", "https://dynamodb.eu-west-1.amazonaws.com/", true],
    ])("is judged on the target %s", (_, target, within) => {
      const refuse = within ? null : "beyond_bound";
      expect(credentialUrlPolicy({ ...injected, target, authorizedUris }).refuse).toBe(refuse);
      const templated = { ...allowAll, target, templates: ["{{api_key}}"], allowAllUris: false };
      expect(credentialUrlPolicy({ ...templated, authorizedUris }).refuse).toBe(refuse);
    });

    it("names the host to list, not the generic allowlist failure", () => {
      const host = "sqs.us-east-1.amazonaws.com";
      const message = urlPolicyRefusalMessage("beyond_bound", "@x/aws", host);
      expect(message).toContain(`${host}'s registrable domain lies outside the literal part`);
      expect(message).toContain("list that host in authorized_uris");
      const generic = urlPolicyRefusalMessage("exfiltration", "@x/aws", host);
      expect(generic).not.toContain("registrable domain");
    });

    it("is refused when only the wildcard matches, and served once the host is listed", () => {
      const target = "https://sqs.us-east-1.amazonaws.com/q";
      const beside = ["https://sts.amazonaws.com/**", ...authorizedUris];
      expect(credentialUrlPolicy({ ...injected, target, authorizedUris: beside }).refuse).toBe(
        "beyond_bound",
      );
      const listed = ["https://sqs.us-east-1.amazonaws.com/**", ...authorizedUris];
      const served = credentialUrlPolicy({ ...injected, target, authorizedUris: listed });
      expect(served.refuse).toBeNull();
    });

    it("is left alone when no credential is carried", () => {
      const policy = credentialUrlPolicy({
        ...allowAll,
        target: "https://s3.amazonaws.com/bucket/key",
        templates: ["https://s3.amazonaws.com/bucket/key"],
        allowAllUris: false,
        authorizedUris,
      });
      expect(policy.refuse).toBeNull();
    });
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
    expect(urlPolicyRefusalMessage("unrendered", "@x/wp", "wp.example")).toContain(
      "does not render",
    );
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

describe("templateHost — the target host a message echoes", () => {
  // The oracle: scrubbing values from a host the caller wrote literally told it whether a
  // guessed host held a field value (here one only injected in a header).
  it("shows a literal host as written, whatever the credential values", () => {
    expect(templateHost("https://us1-eu2-eu3.invalid/x")).toBe("us1-eu2-eu3.invalid");
    expect(templateHost("https://api.example.com/v1?key=abc")).toBe("api.example.com");
  });

  it("names a templated label by its placeholder, not its value", () => {
    expect(templateHost("https://{{ sub }}.example.com/x")).toBe("{{sub}}.example.com");
    // An IDN value would be punycoded on the wire and missed by a value scrub.
    expect(templateHost("https://{{idn}}.example.com/")).toBe("{{idn}}.example.com");
  });

  it("names a whole-host or whole-base-URL field by its placeholder", () => {
    expect(templateHost("https://{{sub}}/x")).toBe("{{sub}}");
    expect(templateHost("{{base_url}}/api/v1")).toBe("{{base_url}}");
  });

  it("is <templated> when the templated host does not parse, <unparseable> otherwise", () => {
    expect(templateHost("https://{{host}}:{{port}}/x")).toBe("<templated>");
    expect(templateHost("not a url")).toBe("<unparseable>");
  });
});

describe("credentialStaysWithinBound", () => {
  it("keeps a credential inside the bound of a wildcard the write-time rule accepts", () => {
    // An authority `*` spans dots: the entry is bounded at write time yet matches a host under
    // a deeper public suffix, which the run-time half refuses to carry a credential to.
    const pattern = "https://*.amazonaws.com/**";
    const beyond = "https://x.s3.amazonaws.com/object";
    expect(isHostUnboundedUriPattern(pattern)).toBe(false);
    expect(matchesAuthorizedUriSpec(pattern, beyond)).toBe(true);
    expect(credentialStaysWithinBound(beyond, [pattern])).toBe(false);
    expect(credentialStaysWithinBound("https://sts.amazonaws.com/", [pattern])).toBe(true);
  });

  it("leaves a URL that does not parse to fetchApiCall, which refuses it", () => {
    expect(credentialStaysWithinBound("not a url", ["https://*.amazonaws.com/**"])).toBe(true);
  });
});
