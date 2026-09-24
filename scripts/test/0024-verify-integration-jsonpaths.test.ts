// SPDX-License-Identifier: Apache-2.0

/**
 * The pure half of pre-flight `0024`: which schema issues are the new JSONPath
 * rule's, and what each refused path becomes in the new grammar — the
 * selection the previous release's reader made, never a different one.
 */

import { describe, it, expect } from "bun:test";
import { evaluateJsonPath } from "@appstrate/afps-shared/jsonpath";
import {
  classifyManifest,
  rewriteJsonPath,
} from "../migration/0024-verify-integration-jsonpaths.ts";

function manifest(
  auth: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "@acme/crm",
    version: "1.0.0",
    type: "integration",
    schema_version: "0.1",
    display_name: "CRM",
    source: { kind: "none" },
    auths: {
      session: {
        type: "custom",
        credentials: { schema: { type: "object", properties: { email: { type: "string" } } } },
        authorized_uris: ["https://api.example.com/**"],
        delivery: { env: { TOKEN: { value: "{$credential.token}" } } },
        ...auth,
      },
    },
    ...overrides,
  };
}

const login = (selector: string, condition = "$.ok") => ({
  connect: {
    login: {
      request: { method: "POST", url: "https://api.example.com/login" },
      success_criteria: [{ condition, type: "jsonpath" }],
      outputs: { token: { context: "$response.body", selector, type: "jsonpath" } },
    },
  },
});

describe("rewriteJsonPath — login selectors (the previous login engine's reading)", () => {
  it.each([
    ["$.x-auth-token", "$['x-auth-token']"],
    ["$.data.0.token", "$.data[0].token"],
    ["$.data[00].token", "$.data[0].token"],
    ["$.data[-0]", "$.data[0]"],
    ["$[ 'a b' ]", "$['a b']"],
    ["$['it\\s']", "$['it\\\\s']"],
    ["$['it's']", "$['it\\'s']"],
    ["", "$"],
  ])("%p → %p", (value, rewrite) => {
    expect(rewriteJsonPath(value, "login")?.rewrite).toBe(rewrite);
  });

  it("selects on the new evaluator what the old one selected", () => {
    const body = { "x-auth-token": "t", data: [{ token: "a" }], "it\\s": 1 };
    expect(evaluateJsonPath(body, rewriteJsonPath("$.x-auth-token", "login")!.rewrite)).toBe("t");
    expect(evaluateJsonPath(body, rewriteJsonPath("$.data.0.token", "login")!.rewrite)).toBe("a");
    expect(evaluateJsonPath(body, rewriteJsonPath("$['it\\s']", "login")!.rewrite)).toBe(1);
  });

  it("flags a digit dot-segment as a guessed index, and not a bracketed one", () => {
    expect(rewriteJsonPath("$.data.0", "login")?.digitIndex).toBe(true);
    expect(rewriteJsonPath("$.data[00]", "login")?.digitIndex).toBe(false);
  });

  it.each(["$..token", "$.items[*]", "$[?(@.ok)]", "token", "$.a[1"])(
    "offers no rewrite for %p, which the previous engine refused too",
    (value) => {
      expect(rewriteJsonPath(value, "login")).toBeNull();
    },
  );
});

describe("rewriteJsonPath — identity_claims (the previous dot-split reading)", () => {
  it.each([
    ["sub", "$.sub"],
    ["user.email", "$.user.email"],
    ["$.x-account-id", "$['x-account-id']"],
    ["$.orgs.0.id", "$.orgs[0].id"],
  ])("%p → %p", (value, rewrite) => {
    expect(rewriteJsonPath(value, "identity_claims")?.rewrite).toBe(rewrite);
  });
});

describe("classifyManifest", () => {
  it("reports nothing for a manifest the schema accepts", () => {
    expect(classifyManifest(manifest(login("$.token")))).toEqual({ jsonpath: [], other: [] });
  });

  it("reports each refused JSONPath with its field, value and rewrite", () => {
    const report = classifyManifest(
      manifest({ ...login("$.data.0.token", "$.x-ok"), identity_claims: { account_id: "sub" } }),
    );
    expect(report.other).toEqual([]);
    expect(
      report.jsonpath
        .map(({ at, value, rewrite }) => ({ at, value, rewrite }))
        .sort((a, b) => a.at.localeCompare(b.at)),
    ).toEqual([
      {
        at: "auths.session.connect.login.outputs.token.selector",
        value: "$.data.0.token",
        rewrite: "$.data[0].token",
      },
      {
        at: "auths.session.connect.login.success_criteria.0.condition",
        value: "$.x-ok",
        rewrite: "$['x-ok']",
      },
      { at: "auths.session.identity_claims.account_id", value: "sub", rewrite: "$.sub" },
    ]);
  });

  it("labels any other issue separately, as pre-existing", () => {
    const report = classifyManifest(
      manifest({ identity_claims: { account_id: "sub" } }, { name: "not a package id" }),
    );
    expect(report.other.length).toBeGreaterThan(0);
    expect(report.other.every((line) => !line.includes("supported: $"))).toBe(true);
  });
});
