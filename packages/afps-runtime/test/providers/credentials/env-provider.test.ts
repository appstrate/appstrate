// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  EnvCredentialProvider,
  normaliseProviderId,
} from "../../../src/providers/credentials/env-provider.ts";
import { AUTH_KINDS } from "../../../src/types/auth-kind.ts";

describe("normaliseProviderId", () => {
  it("uppercases and collapses non-alphanumeric runs to underscores", () => {
    expect(normaliseProviderId("github")).toBe("GITHUB");
    expect(normaliseProviderId("@scope/provider")).toBe("_SCOPE_PROVIDER");
    expect(normaliseProviderId("my-provider.io")).toBe("MY_PROVIDER_IO");
    expect(normaliseProviderId("multi---dash")).toBe("MULTI_DASH");
  });
});

describe("EnvCredentialProvider.getCredentials", () => {
  it("picks up a single credential field", async () => {
    const env = { AFPS_CRED_GITHUB_TOKEN: "ghp_xxx" };
    const p = new EnvCredentialProvider({ env });
    const res = await p.getCredentials("github");
    expect(res.credentials).toEqual({ token: "ghp_xxx" });
    expect(res.authorizedUris).toEqual([]);
    expect(res.allowAllUris).toBe(false);
  });

  it("picks up multiple credential fields for the same provider", async () => {
    const env = {
      AFPS_CRED_SLACK_BOT_TOKEN: "xoxb-1",
      AFPS_CRED_SLACK_APP_TOKEN: "xapp-1",
    };
    const p = new EnvCredentialProvider({ env });
    const res = await p.getCredentials("slack");
    // `_` between words is allowed in field names (we lowercase but don't split)
    expect(res.credentials).toEqual({ bot_token: "xoxb-1", app_token: "xapp-1" });
  });

  it("handles scoped provider ids via normalisation", async () => {
    const env = { AFPS_CRED__SCOPE_PROVIDER_TOKEN: "val" };
    const p = new EnvCredentialProvider({ env });
    const res = await p.getCredentials("@scope/provider");
    expect(res.credentials).toEqual({ token: "val" });
  });

  it("reads reserved envelope metadata (authorizedUris / allowAllUris / expiresAt)", async () => {
    const env = {
      AFPS_CRED_GH_TOKEN: "v",
      AFPS_CRED_GH_AUTHORIZED_URIS: "https://api.github.com,https://uploads.github.com",
      AFPS_CRED_GH_ALLOW_ALL_URIS: "true",
      AFPS_CRED_GH_EXPIRES_AT: "1735689600000",
    };
    const p = new EnvCredentialProvider({ env });
    const res = await p.getCredentials("gh");
    expect(res.credentials).toEqual({ token: "v" });
    expect(res.authorizedUris).toEqual(["https://api.github.com", "https://uploads.github.com"]);
    expect(res.allowAllUris).toBe(true);
    expect(res.expiresAt).toBe(1735689600000);
  });

  it("accepts JSON-array form for AUTHORIZED_URIS", async () => {
    const env = {
      AFPS_CRED_X_TOKEN: "v",
      AFPS_CRED_X_AUTHORIZED_URIS: '["https://a.example","https://b.example"]',
    };
    const p = new EnvCredentialProvider({ env });
    const res = await p.getCredentials("x");
    expect(res.authorizedUris).toEqual(["https://a.example", "https://b.example"]);
  });

  it("accepts common truthy strings for ALLOW_ALL_URIS", async () => {
    for (const raw of ["true", "1", "yes", "TRUE", "Yes"]) {
      const p = new EnvCredentialProvider({
        env: { AFPS_CRED_P_K: "v", AFPS_CRED_P_ALLOW_ALL_URIS: raw },
      });
      expect((await p.getCredentials("p")).allowAllUris).toBe(true);
    }
    for (const raw of ["false", "0", "no", ""]) {
      const p = new EnvCredentialProvider({
        env: { AFPS_CRED_P_K: "v", AFPS_CRED_P_ALLOW_ALL_URIS: raw },
      });
      expect((await p.getCredentials("p")).allowAllUris).toBe(false);
    }
  });

  it("throws when no credential fields are found", async () => {
    const p = new EnvCredentialProvider({ env: {} });
    await expect(p.getCredentials("missing")).rejects.toThrow(/no credentials.*missing/);
  });

  it("isolates providers with the same env — one provider's fields do not leak", async () => {
    const env = {
      AFPS_CRED_GITHUB_TOKEN: "gh",
      AFPS_CRED_GITLAB_TOKEN: "gl",
    };
    const p = new EnvCredentialProvider({ env });
    expect((await p.getCredentials("github")).credentials).toEqual({ token: "gh" });
    expect((await p.getCredentials("gitlab")).credentials).toEqual({ token: "gl" });
  });

  it("ignores undefined env entries", async () => {
    const env = { AFPS_CRED_P_A: undefined, AFPS_CRED_P_B: "v" };
    const p = new EnvCredentialProvider({ env });
    expect((await p.getCredentials("p")).credentials).toEqual({ b: "v" });
  });

  it("defaults supportedAuthKinds to all AUTH_KINDS", () => {
    const p = new EnvCredentialProvider();
    expect(p.supportedAuthKinds()).toEqual([...AUTH_KINDS]);
  });

  it("respects a narrower supportedAuthKinds override", () => {
    const p = new EnvCredentialProvider({ supportedAuthKinds: ["api_key"] });
    expect(p.supportedAuthKinds()).toEqual(["api_key"]);
  });
});
