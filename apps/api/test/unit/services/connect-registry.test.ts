// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { resolveStrategy } from "../../../src/services/connect/registry.ts";
import { OAuth2Strategy } from "../../../src/services/connect/oauth2-strategy.ts";
import { FieldsStrategy } from "../../../src/services/connect/fields-strategy.ts";
import { LoginStrategy } from "../../../src/services/connect/login-strategy.ts";
import { LoginSecretStrategy } from "../../../src/services/connect/login-secret-strategy.ts";
import {
  OrchestratedStrategy,
  type ConnectToolExecutor,
} from "../../../src/services/connect/orchestrated-strategy.ts";
import {
  BrowserConnectStrategy,
  type BrowserConnectExecutor,
} from "../../../src/services/connect/browser-strategy.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { connectToolBlock } from "../../helpers/integration-manifests.ts";

type AuthDef = NonNullable<IntegrationManifest["auths"]>[string];

const auth = (type: AuthDef["type"]): AuthDef => ({ type }) as AuthDef;

const fakeExecutor: ConnectToolExecutor = {
  run: async () => ({ outputs: { JSESSIONID: "x" }, expiresAt: null }),
};
const fakeBrowserExecutor: BrowserConnectExecutor = {
  run: async () => ({
    outputs: { cookie: "session=x" },
    proof: { kind: "authenticated-endpoint", succeeded: true },
  }),
};

describe("resolveStrategy", () => {
  it("maps oauth2 → OAuth2Strategy (with begin)", () => {
    const s = resolveStrategy(auth("oauth2"));
    expect(s).toBeInstanceOf(OAuth2Strategy);
    expect(typeof s.begin).toBe("function");
  });

  it("maps api_key / basic / mtls / bare custom → FieldsStrategy (no begin)", () => {
    // AFPS §7.2 — mtls reuses FieldsStrategy: the user
    // pastes a cert + key bag, the manifest's credentials.schema validates it,
    // and the spawn resolver materialises the fields into `delivery.files`
    // entries at runtime. No interactive step (no `begin`) beyond the bag.
    for (const t of ["api_key", "basic", "mtls", "custom"] as const) {
      const s = resolveStrategy(auth(t));
      expect(s).toBeInstanceOf(FieldsStrategy);
      expect(s.begin).toBeUndefined();
    }
  });

  it("maps custom + connect.login → LoginStrategy", () => {
    const a = { type: "custom", connect: { login: {} } } as unknown as AuthDef;
    expect(resolveStrategy(a)).toBeInstanceOf(LoginStrategy);
  });

  it("maps custom + connect.tool + run-start → LoginSecretStrategy (no executor needed)", () => {
    const a = {
      type: "custom",
      connect: connectToolBlock({ tool: "login", runAt: "run-start" }),
    } as unknown as AuthDef;
    // No executor supplied — run-start stores only the secret, so it must
    // resolve without one (the session is minted at run-start by the sidecar).
    expect(resolveStrategy(a)).toBeInstanceOf(LoginSecretStrategy);
  });

  it("maps custom + connect.tool + link → OrchestratedStrategy when an executor is supplied", () => {
    const a = {
      type: "custom",
      connect: connectToolBlock({ tool: "login", runAt: "link" }),
    } as unknown as AuthDef;
    const s = resolveStrategy(a, { connectToolExecutor: fakeExecutor });
    expect(s).toBeInstanceOf(OrchestratedStrategy);
  });

  it("maps an explicit browser executor only to the trusted browser strategy", () => {
    const a = {
      type: "custom",
      connect: connectToolBlock({
        tool: "login",
        runAt: "link",
        produces: ["cookie"],
        browserExecutor: { sessionMode: "exportable" },
      }),
    } as unknown as AuthDef;
    expect(
      resolveStrategy(a, {
        connectToolExecutor: fakeExecutor,
        browserConnectExecutor: fakeBrowserExecutor,
      }),
    ).toBeInstanceOf(BrowserConnectStrategy);
    expect(() => resolveStrategy(a, { connectToolExecutor: fakeExecutor })).toThrow(
      /trusted browser connect executor/,
    );
  });

  it("throws for custom + connect.tool + link with no executor (no silent half-acquisition)", () => {
    const a = {
      type: "custom",
      connect: connectToolBlock({ tool: "login", runAt: "link" }),
    } as unknown as AuthDef;
    expect(() => resolveStrategy(a)).toThrow(/connect-run substrate/);
  });

  it("throws for an unknown auth type without a connect strategy", () => {
    const a = { type: "unsupported" } as unknown as AuthDef;
    expect(() => resolveStrategy(a)).toThrow(/no connect strategy/);
  });
});

describe("FieldsStrategy.complete", () => {
  it("refuses a wrong-kind input rather than persisting", async () => {
    // Defence-in-depth: the route guards oauth2 too, but the strategy
    // rejects a non-fields input before any DB access.
    const s = new FieldsStrategy();
    await expect(
      s.complete(
        {
          scope: { orgId: "o", applicationId: "a" },
          actor: { type: "user", id: "u" },
          integrationId: "@x/y",
          authKey: "k",
        },
        { kind: "oauth2-result", result: {} as never },
      ),
    ).rejects.toThrow(/unexpected input kind/);
  });
});
