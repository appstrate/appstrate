// SPDX-License-Identifier: Apache-2.0

/**
 * `identity_claims` accessors: a bare path, or a template.
 *
 * An OAuth auth names one field the IdP already returns (`$.email`), and that
 * is the whole grammar the mapping needed for as long as every integration was
 * OAuth-shaped. Some identities are COMPOSITE and no single path can express
 * one: an SSH connection is a Unix account ON a host, and `@appstrate/ssh` is
 * built to carry several connections to the same machine — that is why each key
 * gets its own dispatcher — so naming one by its host alone gives two of them
 * the same account id, and naming it by the account alone collides across
 * hosts.
 *
 * The template reuses the `{$credential.<field>}` grammar the `delivery`
 * blocks already interpolate with, so a manifest writes a credential reference
 * the same way wherever it appears.
 *
 * What these pin is the FAIL-CLOSED half. A half-rendered `"@vps.example.com"`
 * would be worse than no identity at all: it reads like a real account key, it
 * would be stored, labelled and deduplicated against, and nothing downstream
 * could tell it from a deliberate one.
 */

import { describe, it, expect } from "bun:test";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { extractIdentity } from "../../../src/services/integration-connections.ts";

function manifestWith(claims: Record<string, string>): IntegrationManifest {
  return {
    name: "@test/identity",
    type: "integration",
    auths: { primary: { type: "custom", identity_claims: claims } },
  } as unknown as IntegrationManifest;
}

const SSH_MAPPING = { account_id: "{$credential.user}@{$credential.host}" };
const bag = { user: "appstrate", host: "vps.example.com", port: "22" };

describe("identity_claims — composite template", () => {
  it("renders every referenced credential field", () => {
    const { accountId, identityClaims } = extractIdentity(
      manifestWith(SSH_MAPPING),
      "primary",
      bag,
    );
    expect(accountId).toBe("appstrate@vps.example.com");
    expect(identityClaims.account_id).toBe("appstrate@vps.example.com");
  });

  it("trims the rendered fields — a pasted host must not carry whitespace into a label", () => {
    const { accountId } = extractIdentity(manifestWith(SSH_MAPPING), "primary", {
      user: " appstrate ",
      host: "vps.example.com\n",
    });
    expect(accountId).toBe("appstrate@vps.example.com");
  });

  it.each([
    ["a missing field", { host: "vps.example.com" }],
    ["an empty field", { user: "", host: "vps.example.com" }],
    ["a whitespace-only field", { user: "   ", host: "vps.example.com" }],
    ["a non-string field", { user: 42, host: "vps.example.com" }],
    ["both fields absent", {}],
  ])("falls back to the 'default' sentinel on %s, never a half-rendered key", (_label, source) => {
    const { accountId } = extractIdentity(
      manifestWith(SSH_MAPPING),
      "primary",
      source as Record<string, unknown>,
    );
    // Not `"@vps.example.com"`, not `"appstrate@"` — the sentinel every caller
    // already reads as "no identity resolved".
    expect(accountId).toBe("default");
  });

  it("keeps a template out of a claim that is a plain separator", () => {
    // A template rendering to only its literal parts is still not an identity.
    const { accountId } = extractIdentity(
      manifestWith({ account_id: "{$credential.user}@" }),
      "primary",
      {
        host: "vps.example.com",
      },
    );
    expect(accountId).toBe("default");
  });
});

/**
 * A reference the grammar does not admit used to survive substitution as
 * literal text and BECOME the identity: `{$credential.my-host}` named a
 * connection `appstrate@{$credential.my-host}`, displayed to the user, because
 * the form was decided by a substring test that squeezed three states — path,
 * template, malformed — into two, and the third left through the template arm
 * wearing its own syntax.
 *
 * The sentinel is the contract for all of them: an identity is displayed and
 * compared, so refusing is the only safe answer and a manifest typo must read
 * as "no identity", never as an identity that happens to contain braces.
 */
describe("identity_claims — a malformed reference never becomes an identity", () => {
  it.each([
    ["a hyphen in the field name", "{$credential.user}@{$credential.my-host}"],
    ["a dot in the field name", "{$credential.user}@{$credential.a.b}"],
    ["an unclosed brace", "{$credential.user@host"],
    ["no field at all", "{$credential}"],
    ["a misspelled opener", "{$credentialx.user}"],
  ])("refuses %s", (_label, accessor) => {
    const { accountId, identityClaims } = extractIdentity(
      manifestWith({ account_id: accessor }),
      "primary",
      bag,
    );
    expect(accountId).toBe("default");
    expect(identityClaims.account_id).toBe("");
  });

  it("refuses the whole accessor, not just the reference it could not read", () => {
    // The half that DID resolve must not leak either: `appstrate@` is a
    // plausible-looking identity that silently collides with every other
    // connection whose second half failed.
    const { identityClaims } = extractIdentity(
      manifestWith({ account_id: "{$credential.user}@{$credential.my-host}" }),
      "primary",
      bag,
    );
    expect(identityClaims.account_id).not.toContain("appstrate");
  });
});

describe("identity_claims — the bare-path form is untouched", () => {
  it("reads a single field", () => {
    const { accountId } = extractIdentity(manifestWith({ account_id: "$.email" }), "primary", {
      email: "pierre@example.com",
    });
    expect(accountId).toBe("pierre@example.com");
  });

  it("reads a nested path", () => {
    const { accountId } = extractIdentity(manifestWith({ account_id: "$.data.email" }), "primary", {
      data: { email: "gsanchez@example.com" },
    });
    expect(accountId).toBe("gsanchez@example.com");
  });

  it("still yields the sentinel on a path that does not exist", () => {
    const { accountId } = extractIdentity(
      manifestWith({ account_id: "$.nope.deeper" }),
      "primary",
      {
        login: "pierre",
      },
    );
    expect(accountId).toBe("default");
  });

  it("falls through to the conventional fields before the sentinel", () => {
    // Pre-existing behaviour worth stating: a mapping that resolves to nothing
    // does NOT go straight to "default" — `extractIdentity` still tries
    // `email` / `account_email` / `sub` on the bag. A broken accessor therefore
    // looks healthy whenever the payload happens to carry one of those, which
    // is why `system-package-identity-claims.test.ts` pins each mapping against
    // a real payload instead of trusting this chain.
    const { accountId } = extractIdentity(manifestWith({ account_id: "$.nope" }), "primary", {
      email: "pierre@example.com",
    });
    expect(accountId).toBe("pierre@example.com");
  });

  it("does not treat a brace-free accessor as a template", () => {
    // `$credential.user` without braces is a PATH, and there is no such field.
    const { accountId } = extractIdentity(
      manifestWith({ account_id: "$credential.user" }),
      "primary",
      bag,
    );
    expect(accountId).toBe("default");
  });
});
