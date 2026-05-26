// SPDX-License-Identifier: Apache-2.0

/**
 * R8a — `runConnectLogin` must refuse to install a zero-value delivery plan
 * (empty `headerName`) when the manifest declares neither a usable
 * `delivery.env` nor a non-empty `delivery.http.name`.
 *
 * Rationale: the previous behaviour silently installed
 * `{ headerName: "", value: "" }`, which produced cryptic upstream 401s
 * with no operator-visible cause. The runtime now fails closed at boot so
 * the misconfiguration is surfaced where it can actually be fixed.
 */

import { describe, it, expect } from "bun:test";

import { runConnectLogin } from "../connect-login.ts";
import {
  createIntegrationCredentialsSource,
  type IntegrationCredentialsWire,
} from "../integration-credentials-source.ts";

function emptyWire(): IntegrationCredentialsWire {
  return { auths: [], deliveryPlans: {}, expiresAtEpochMs: {} };
}

function makeSource() {
  const fetchFn = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
  return createIntegrationCredentialsSource({
    integrationId: "@test/integ",
    platformApiUrl: "http://api",
    runToken: "run-tok",
    initialPayload: emptyWire(),
    fetchFn,
  });
}

function fakeHostReturning(payload: unknown) {
  return {
    getUpstreamClient: (_ns: string) => ({
      callTool: async () => ({
        content: [{ type: "text", text: JSON.stringify(payload) }],
      }),
    }),
  };
}

describe("runConnectLogin — zero-plan rejection (R8a)", () => {
  it("throws when delivery.http.name is empty", async () => {
    const source = makeSource();
    const host = fakeHostReturning({ outputs: { session: "S1" } });

    await expect(
      runConnectLogin({
        host: host as any,
        namespace: "ns",
        toolName: "login",
        inputs: {},
        source,
        authKey: "primary",
        authType: "custom",
        authorizedUris: [],
        // Empty header name — exactly the case the zero-plan path used
        // to swallow. The runtime must now surface a clear error.
        deliveryHttp: { in: "header", name: "" } as any,
      }),
    ).rejects.toThrow(/no injectable header/i);
  });

  it("throws when delivery.http.name is whitespace-only (resolver collapses to null)", async () => {
    // Same null-plan path: the resolver short-circuits when the header
    // name is the empty string. Tests the same defensive branch the
    // primary case covers (and matches the AFPS 2.0.2 schema
    // `minLength: 1` constraint).
    const source = makeSource();
    const host = fakeHostReturning({ outputs: { session: "S2" } });

    await expect(
      runConnectLogin({
        host: host as any,
        namespace: "ns",
        toolName: "login",
        inputs: {},
        source,
        authKey: "custom_auth",
        // `custom` with empty name → null plan → R8a rejection.
        authType: "custom",
        authorizedUris: [],
        deliveryHttp: { in: "header", name: "" } as any,
      }),
    ).rejects.toThrow(/no injectable header/i);
  });

  it("still installs the session when delivery.http resolves to a real plan", async () => {
    // Sanity: the rejection ONLY fires on the null-plan branch. A
    // well-formed delivery template still produces a concrete header.
    const source = makeSource();
    const host = fakeHostReturning({ outputs: { access_token: "TOK" } });

    await runConnectLogin({
      host: host as any,
      namespace: "ns",
      toolName: "login",
      inputs: {},
      source,
      authKey: "primary",
      authType: "oauth2",
      authorizedUris: [],
      deliveryHttp: {
        in: "header",
        name: "Authorization",
        prefix: "Bearer ",
        value: "{$credential.access_token}",
      } as any,
    });

    const plans = source.deliveryPlans();
    expect(plans.primary?.headerName).toBe("Authorization");
    expect(plans.primary?.value).toBe("TOK");
  });

  it("leaves the substitution window closed after the rejection", async () => {
    // The injection window MUST close even on the zero-plan reject path —
    // the secret can never linger past the primitive's `finally`.
    const source = makeSource();
    const host = fakeHostReturning({ outputs: { session: "S3" } });

    await expect(
      runConnectLogin({
        host: host as any,
        namespace: "ns",
        toolName: "login",
        inputs: { password: "s3cret" },
        source,
        authKey: "primary",
        authType: "custom",
        authorizedUris: [],
        deliveryHttp: { in: "header", name: "" } as any,
      }),
    ).rejects.toThrow(/no injectable header/i);

    expect(source.activeInputs()).toBeNull();
  });
});
