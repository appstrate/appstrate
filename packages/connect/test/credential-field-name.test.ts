// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { getCredentialFieldName } from "../src/registry.ts";
import type { ProviderDefinition } from "../src/types.ts";

function provider(overrides: Partial<ProviderDefinition>): ProviderDefinition {
  return {
    id: "@test/provider",
    authMode: "oauth2",
    authorizedUris: [],
    ...overrides,
  } as ProviderDefinition;
}

describe("getCredentialFieldName", () => {
  it("returns 'access_token' for oauth2 providers", () => {
    expect(getCredentialFieldName(provider({ authMode: "oauth2" }))).toBe("access_token");
  });

  it("returns 'api_key' for api_key providers", () => {
    expect(getCredentialFieldName(provider({ authMode: "api_key" }))).toBe("api_key");
  });

  it("returns 'access_token' for oauth1 providers", () => {
    expect(getCredentialFieldName(provider({ authMode: "oauth1" }))).toBe("access_token");
  });

  it("returns 'access_token' for basic providers without override", () => {
    expect(getCredentialFieldName(provider({ authMode: "basic" }))).toBe("access_token");
  });

  it("uses credentialFieldName override when set", () => {
    expect(
      getCredentialFieldName(provider({ authMode: "oauth2", credentialFieldName: "token" })),
    ).toBe("token");
  });

  it("uses credentialFieldName override for api_key mode too", () => {
    expect(
      getCredentialFieldName(provider({ authMode: "api_key", credentialFieldName: "secret" })),
    ).toBe("secret");
  });
});
