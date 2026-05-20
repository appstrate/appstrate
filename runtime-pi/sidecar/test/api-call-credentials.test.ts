// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  createApiCallCredentialAdapter,
  API_CALL_INJECTED_FIELD,
} from "../api-call-credentials.ts";
import type { IntegrationCredentialsSource } from "../integration-credentials-source.ts";

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
    expect(creds.credentialFieldName).toBe(API_CALL_INJECTED_FIELD);
    expect(creds.credentials[API_CALL_INJECTED_FIELD]).toBe("AT");
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

  it("refreshCredentials triggers refreshOnUnauthorized and re-snapshots", async () => {
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
    await adapter.refreshCredentials("@scope/integ");
    expect(refreshed).toBe(true);
  });
});
