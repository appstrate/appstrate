// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { createApiCallCredentialAdapter } from "../api-call-credentials.ts";
import { PROXY_INJECTED_FIELD } from "@appstrate/connect/integration-credentials";
import {
  createIntegrationCredentialsSource,
  type IntegrationCredentialsSource,
  type IntegrationCredentialsWire,
} from "../integration-credentials-source.ts";

function fakeSource(
  payload: {
    auths: Array<{ authKey: string; authType: string; fields: Record<string, string> }>;
    deliveryPlans: Record<string, { headerName: string; headerPrefix: string; value: string }>;
  },
  onRefresh?: () => void,
): IntegrationCredentialsSource {
  const wire = {
    auths: payload.auths.map((a) => ({
      ...a,
      authorizedUris: [] as string[],
      identityClaims: {},
      expiresAt: null,
      scopesGranted: [] as string[],
    })),
    deliveryPlans: payload.deliveryPlans,
    expiresAtEpochMs: {},
  };
  return {
    current: () => ({ auths: wire.auths }),
    deliveryPlans: () => wire.deliveryPlans,
    refreshOnUnauthorized: async () => {
      onRefresh?.();
      return true;
    },
    snapshot: () => wire,
  } as unknown as IntegrationCredentialsSource;
}

describe("createApiCallCredentialAdapter", () => {
  it("maps an oauth2 delivery plan into an injectable proxy payload", async () => {
    const source = fakeSource({
      auths: [{ authKey: "primary", authType: "oauth2", fields: { access_token: "AT" } }],
      deliveryPlans: {
        primary: { headerName: "Authorization", headerPrefix: "Bearer ", value: "AT" },
      },
    });
    const adapter = createApiCallCredentialAdapter({
      source,
      authKey: "primary",
      authorizedUris: ["https://api.example.com/**"],
    });
    const creds = await adapter.fetchCredentials("@scope/integ");
    expect(creds.credentialHeaderName).toBe("Authorization");
    expect(creds.credentialHeaderPrefix).toBe("Bearer ");
    expect(creds.credentialFieldName).toBe(PROXY_INJECTED_FIELD);
    expect(creds.credentials[PROXY_INJECTED_FIELD]).toBe("AT");
    // The raw auth fields stay available for {{var}} substitution.
    expect(creds.credentials.access_token).toBe("AT");
    expect(creds.authorizedUris).toEqual(["https://api.example.com/**"]);
    expect(creds.allowAllUris).toBe(false);
  });

  it("omits header injection when the auth declares no delivery.http (custom auth)", async () => {
    const source = fakeSource({
      auths: [{ authKey: "primary", authType: "custom", fields: { token: "T" } }],
      deliveryPlans: {},
    });
    const adapter = createApiCallCredentialAdapter({
      source,
      authKey: "primary",
      authorizedUris: ["https://api.example.com/**"],
    });
    const creds = await adapter.fetchCredentials("@scope/integ");
    expect(creds.credentialHeaderName).toBeUndefined();
    // Fields still exposed so the agent can {{token}}-substitute.
    expect(creds.credentials.token).toBe("T");
  });
});

/**
 * THE objective regression guard (W0): a connect.tool run-start session,
 * installed on the SHARED credentials source via `setSessionOutputs` (what
 * `runConnectLogin` does at boot), MUST become visible to the `api_call`
 * adapter bound to the SAME source on the SAME authKey. Uses the REAL source
 * (not a fake) so the wiring `setSessionOutputs → snapshot → toPayload` is
 * exercised end-to-end.
 */
describe("createApiCallCredentialAdapter — connect.tool session via shared source", () => {
  // Initial payload mirrors what GET /internal/integration-credentials returns
  // for a run-start connect.tool connection BEFORE login: the `session` auth is
  // present with empty fields + a placeholder (empty-value) delivery plan.
  function preLoginPayload(): IntegrationCredentialsWire {
    return {
      auths: [
        {
          authKey: "session",
          authType: "custom",
          fields: {},
          authorizedUris: ["https://connecttool.test/**"],
        },
      ],
      deliveryPlans: {
        session: {
          headerName: "Authorization",
          headerPrefix: "Bearer ",
          value: "",
          allowServerOverride: false,
        },
      },
      expiresAtEpochMs: { session: null },
    };
  }

  it("api_call injects the captured session header after setSessionOutputs", async () => {
    const source = createIntegrationCredentialsSource({
      integrationId: "@appstrate/connect-tool-test",
      platformApiUrl: "http://api",
      runToken: "rt",
      initialPayload: preLoginPayload(),
    });
    const adapter = createApiCallCredentialAdapter({
      source,
      authKey: "session",
      authorizedUris: ["https://connecttool.test/**"],
    });

    // BEFORE login: placeholder plan → empty injected value.
    const before = await adapter.fetchCredentials("@appstrate/connect-tool-test");
    expect(before.credentials[PROXY_INJECTED_FIELD]).toBe("");

    // Simulate connect-login at boot: runConnectLogin → setSessionOutputs.
    source.setSessionOutputs(
      {
        authKey: "session",
        authType: "custom",
        fields: { session_token: "SESS123" },
        authorizedUris: ["https://connecttool.test/**"],
      },
      {
        headerName: "Authorization",
        headerPrefix: "Bearer ",
        value: "SESS123",
        allowServerOverride: false,
      },
    );

    // AFTER login: the api_call adapter (same source, same authKey) injects the
    // captured session header — proving connect.tool → api_call end-to-end.
    const after = await adapter.fetchCredentials("@appstrate/connect-tool-test");
    expect(after.credentialHeaderName).toBe("Authorization");
    expect(after.credentialHeaderPrefix).toBe("Bearer ");
    expect(after.credentials[PROXY_INJECTED_FIELD]).toBe("SESS123");
    // The captured login output is also exposed for {{var}} substitution.
    expect(after.credentials.session_token).toBe("SESS123");
  });

  it("keeps a sibling api_key auth injectable after the connect.tool session is minted", async () => {
    // Multi-auth: `session` (connect.tool) + `apikey` (static, also api_call).
    const source = createIntegrationCredentialsSource({
      integrationId: "@vendor/multi",
      platformApiUrl: "http://api",
      runToken: "rt",
      initialPayload: {
        auths: [
          { authKey: "session", authType: "custom", fields: {}, authorizedUris: ["https://x/**"] },
          {
            authKey: "apikey",
            authType: "api_key",
            fields: { apiKey: "KEEP" },
            authorizedUris: ["https://x/**"],
          },
        ],
        deliveryPlans: {
          session: {
            headerName: "Authorization",
            headerPrefix: "Bearer ",
            value: "",
            allowServerOverride: false,
          },
          apikey: {
            headerName: "X-Api-Key",
            headerPrefix: "",
            value: "KEEP",
            allowServerOverride: false,
          },
        },
        expiresAtEpochMs: { session: null, apikey: null },
      },
    });
    const sessionAdapter = createApiCallCredentialAdapter({
      source,
      authKey: "session",
      authorizedUris: ["https://x/**"],
    });
    const apikeyAdapter = createApiCallCredentialAdapter({
      source,
      authKey: "apikey",
      authorizedUris: ["https://x/**"],
    });

    source.setSessionOutputs(
      {
        authKey: "session",
        authType: "custom",
        fields: { session_token: "S" },
        authorizedUris: ["https://x/**"],
      },
      {
        headerName: "Authorization",
        headerPrefix: "Bearer ",
        value: "S",
        allowServerOverride: false,
      },
    );

    // Session auth now injects the minted session...
    const sess = await sessionAdapter.fetchCredentials("@vendor/multi");
    expect(sess.credentials[PROXY_INJECTED_FIELD]).toBe("S");
    // ...AND the sibling api_key auth still injects its own key (not wiped).
    const key = await apikeyAdapter.fetchCredentials("@vendor/multi");
    expect(key.credentialHeaderName).toBe("X-Api-Key");
    expect(key.credentials[PROXY_INJECTED_FIELD]).toBe("KEEP");
  });
});

describe("createApiCallCredentialAdapter — refresh re-snapshot", () => {
  it("refreshCredentials triggers refresh, re-snapshots, and returns the rotated payload", async () => {
    let refreshed = false;
    const source = fakeSource(
      {
        auths: [{ authKey: "primary", authType: "oauth2", fields: { access_token: "AT" } }],
        deliveryPlans: {
          primary: { headerName: "Authorization", headerPrefix: "Bearer ", value: "AT" },
        },
      },
      () => {
        refreshed = true;
      },
    );
    const adapter = createApiCallCredentialAdapter({
      source,
      authKey: "primary",
      authorizedUris: ["https://api.example.com/**"],
    });
    const result = await adapter.refreshCredentials("@scope/integ");
    expect(refreshed).toBe(true);
    expect(result?.credentials[PROXY_INJECTED_FIELD]).toBe("AT");
    // oauth2 → can rotate → the proxy refreshes immediately (no same-cred retry).
    expect(adapter.refreshable).toBe(true);
  });

  it("refreshable is false for a non-oauth2 auth (drives the proxy's same-credential retry)", async () => {
    const source = fakeSource({
      auths: [{ authKey: "primary", authType: "api_key", fields: { api_key: "K" } }],
      deliveryPlans: { primary: { headerName: "X-Api-Key", headerPrefix: "", value: "K" } },
    });
    const adapter = createApiCallCredentialAdapter({
      source,
      authKey: "primary",
      authorizedUris: ["https://api.example.com/**"],
    });
    expect(adapter.refreshable).toBe(false);
  });

  it("refreshCredentials returns null when the credential was NOT rotated", async () => {
    const source = {
      current: () => ({ auths: [] }),
      deliveryPlans: () => ({}),
      refreshOnUnauthorized: async () => false,
      snapshot: () => ({ auths: [], deliveryPlans: {}, expiresAtEpochMs: {} }),
    } as unknown as IntegrationCredentialsSource;
    const adapter = createApiCallCredentialAdapter({
      source,
      authKey: "primary",
      authorizedUris: ["https://api.example.com/**"],
    });
    expect(await adapter.refreshCredentials("@scope/integ")).toBeNull();
  });
});
