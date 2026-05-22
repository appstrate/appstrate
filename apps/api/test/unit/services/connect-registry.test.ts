// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { resolveStrategy } from "../../../src/services/connect/registry.ts";
import { OAuth2Strategy } from "../../../src/services/connect/oauth2-strategy.ts";
import { FieldsStrategy } from "../../../src/services/connect/fields-strategy.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";

type AuthDef = NonNullable<IntegrationManifest["auths"]>[string];

const auth = (type: AuthDef["type"]): AuthDef => ({ type }) as AuthDef;

describe("resolveStrategy", () => {
  it("maps oauth2 → OAuth2Strategy (with begin)", () => {
    const s = resolveStrategy(auth("oauth2"));
    expect(s).toBeInstanceOf(OAuth2Strategy);
    expect(typeof s.begin).toBe("function");
  });

  it("maps api_key / basic / custom → FieldsStrategy (no begin)", () => {
    for (const t of ["api_key", "basic", "custom"] as const) {
      const s = resolveStrategy(auth(t));
      expect(s).toBeInstanceOf(FieldsStrategy);
      expect(s.begin).toBeUndefined();
    }
  });

  it("throws for an auth type without a connect strategy (oauth1)", () => {
    expect(() => resolveStrategy(auth("oauth1"))).toThrow();
  });
});

describe("FieldsStrategy.complete", () => {
  it("refuses a wrong-kind input rather than persisting", async () => {
    // Defence-in-depth: the route guards oauth/oauth1 too, but the strategy
    // rejects a non-fields input before any DB access.
    const s = new FieldsStrategy();
    await expect(
      s.complete(
        {
          scope: { orgId: "o", applicationId: "a" },
          actor: { type: "user", id: "u" },
          integrationPackageId: "@x/y",
          authKey: "k",
        },
        { kind: "oauth2-result", result: {} as never },
      ),
    ).rejects.toThrow(/unexpected input kind/);
  });
});
