// SPDX-License-Identifier: Apache-2.0

/**
 * `extractIdentity` reads `identity_claims` with the manifest JSONPath dialect
 * (`@appstrate/afps-shared/jsonpath`) — the one the login engine reads its
 * selectors with. Pure function, no DB.
 */

import { describe, it, expect } from "bun:test";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { ApiError } from "@appstrate/core/api-errors";
import { extractIdentity } from "../../../src/services/integration-connections.ts";

function manifestWith(identityClaims?: Record<string, string>): IntegrationManifest {
  return {
    type: "integration",
    schema_version: "0.1",
    source: { kind: "none" },
    auths: {
      primary: {
        type: "oauth2",
        delivery: { http: { in: "header", name: "Authorization", value: "Bearer x" } },
        ...(identityClaims ? { identity_claims: identityClaims } : {}),
      },
    },
  } as unknown as IntegrationManifest;
}

describe("extractIdentity", () => {
  it("reads indices and quoted members, which the old dot-split reader missed", () => {
    const m = manifestWith({
      accountId: "$.emails[0].value",
      name: "$['display name']",
    });
    const { accountId, identityClaims } = extractIdentity(m, "primary", {
      emails: [{ value: "ada@example.com" }],
      "display name": "Ada",
    });
    expect(accountId).toBe("ada@example.com");
    expect(identityClaims).toEqual({ accountId: "ada@example.com", name: "Ada" });
  });

  it("leaves a claim the provider did not return out of the bag", () => {
    const m = manifestWith({ accountId: "$.login", email: "$.email" });
    const { identityClaims } = extractIdentity(m, "primary", { login: "ada" });
    expect(identityClaims).toEqual({ accountId: "ada" });
    expect("email" in identityClaims).toBe(false);
  });

  it("returns a null account id when the provider exposed no identity", () => {
    const { accountId } = extractIdentity(manifestWith(), "primary", { access_token: "t" });
    expect(accountId).toBeNull();
  });

  it("treats an account literally named 'default' as a real identity", () => {
    const m = manifestWith({ accountId: "$.login" });
    expect(extractIdentity(m, "primary", { login: "default" }).accountId).toBe("default");
  });

  it.each(["login", "$..login", "$.users[*].id"])(
    "fails the connect with invalid_config on the unsupported path %p",
    (path) => {
      const m = manifestWith({ accountId: path });
      let caught: unknown;
      try {
        extractIdentity(m, "primary", { login: "ada" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).code).toBe("invalid_config");
      expect((caught as ApiError).message).toContain("auths.primary.identity_claims.accountId");
    },
  );
});
