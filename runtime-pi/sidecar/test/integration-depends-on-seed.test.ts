// SPDX-License-Identifier: Apache-2.0

/**
 * connect.dependsOn — sidecar-side seeding of dependency credentials into the
 * login runner's MITM credentials source.
 *
 * Verifies the wiring contract that lets a `connect.tool` login dance call
 * OTHER integrations' upstream APIs (e.g. craigslist → Gmail magic-link):
 *
 *   - `seedDependencyAuths` appends each dependency auth + its delivery plan to
 *     the source's payload (`current()` / `deliveryPlans()`).
 *   - Fed through the real `planMitmAction`, a request to a DEPENDENCY's
 *     authorizedUri gets the dependency's credential injected.
 *   - A request to the LOGIN integration's own host gets the login auth (its
 *     captured-session / substitution path is untouched — distinct authKey).
 *   - A request to NEITHER host gets nothing injected (bounded by
 *     authorizedUris).
 */

import { describe, it, expect } from "bun:test";
import { planMitmAction } from "@appstrate/connect/integration-mitm-planner";
import {
  createIntegrationCredentialsSource,
  type IntegrationCredentialsWire,
} from "../integration-credentials-source.ts";

/** Login integration's own auth — its host + token. */
function loginPayload(): IntegrationCredentialsWire {
  return {
    auths: [
      {
        authKey: "session",
        authType: "custom",
        fields: { sessionCookie: "login-tok" },
        authorizedUris: ["https://login.test.appstrate.dev/**"],
      },
    ],
    deliveryPlans: {
      session: {
        headerName: "X-Login-Token",
        headerPrefix: "",
        value: "login-tok",
        allowServerOverride: false,
      },
    },
    expiresAtEpochMs: { session: null },
  };
}

function makeSource(initial: IntegrationCredentialsWire) {
  const fetchFn = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
  return createIntegrationCredentialsSource({
    integrationId: "@test/login-integ",
    platformApiUrl: "http://api",
    runToken: "run-tok",
    initialPayload: initial,
    fetchFn,
  });
}

const depAuth = {
  authKey: "@test/dep::primary",
  authType: "oauth2",
  fields: { accessToken: "dep-tok" },
  authorizedUris: ["https://dep.test.appstrate.dev/**"],
};
const depPlan = {
  headerName: "X-Dep-Token",
  headerPrefix: "Bearer ",
  value: "dep-tok",
  allowServerOverride: false,
};

describe("connect.dependsOn — seedDependencyAuths", () => {
  it("appends dependency auths + delivery plans to the payload", () => {
    const source = makeSource(loginPayload());
    source.seedDependencyAuths([{ auth: depAuth, plan: depPlan }]);

    const cur = source.current();
    expect(cur.auths.map((a) => a.authKey).sort()).toEqual(["@test/dep::primary", "session"]);
    expect(source.deliveryPlans()["@test/dep::primary"]?.value).toBe("dep-tok");
    // Login auth's own plan is left untouched.
    expect(source.deliveryPlans().session?.value).toBe("login-tok");
  });

  it("is a no-op for an empty dependency list", () => {
    const source = makeSource(loginPayload());
    source.seedDependencyAuths([]);
    expect(source.current().auths).toHaveLength(1);
  });

  it("planMitmAction injects the dependency credential for the dependency host", () => {
    const source = makeSource(loginPayload());
    source.seedDependencyAuths([{ auth: depAuth, plan: depPlan }]);

    const action = planMitmAction(
      {
        url: "https://dep.test.appstrate.dev/inbox",
        headerNames: [],
        deliveryPlans: source.deliveryPlans(),
      },
      source.current(),
    );
    expect(action.matchedAuth?.authKey).toBe("@test/dep::primary");
    expect(action.injectedHeader).toEqual({ name: "X-Dep-Token", value: "Bearer dep-tok" });
  });

  it("planMitmAction injects the login auth for the login integration's own host", () => {
    const source = makeSource(loginPayload());
    source.seedDependencyAuths([{ auth: depAuth, plan: depPlan }]);

    const action = planMitmAction(
      {
        url: "https://login.test.appstrate.dev/authenticate",
        headerNames: [],
        deliveryPlans: source.deliveryPlans(),
      },
      source.current(),
    );
    expect(action.matchedAuth?.authKey).toBe("session");
    expect(action.injectedHeader).toEqual({ name: "X-Login-Token", value: "login-tok" });
  });

  it("planMitmAction injects nothing for a host outside every authorizedUris", () => {
    const source = makeSource(loginPayload());
    source.seedDependencyAuths([{ auth: depAuth, plan: depPlan }]);

    const action = planMitmAction(
      {
        url: "https://unrelated.example.com/data",
        headerNames: [],
        deliveryPlans: source.deliveryPlans(),
      },
      source.current(),
    );
    expect(action.matchedAuth).toBeNull();
    expect(action.injectedHeader).toBeNull();
  });
});
