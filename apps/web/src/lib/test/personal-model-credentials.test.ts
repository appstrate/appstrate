// SPDX-License-Identifier: Apache-2.0

/**
 * The request bodies and filters behind the personal model credentials page.
 * The body is what the server reads for ownership: a personal API key must
 * leave `owner_type: "user"` on the wire, or it would become an org credential.
 */

import { describe, it, expect } from "bun:test";
import {
  personalApiKeyBody,
  personalApiKeyProviders,
  ownPersonalCredentials,
  modelsPaidByCaller,
} from "../personal-model-credentials.ts";

describe("personalApiKeyProviders", () => {
  it("offers key-based providers only, never a subscription or a custom endpoint", () => {
    const registry: {
      providerId: string;
      authMode: "api_key" | "oauth2";
      baseUrlOverridable: boolean;
    }[] = [
      { providerId: "openai", authMode: "api_key", baseUrlOverridable: false },
      { providerId: "openai-compatible", authMode: "api_key", baseUrlOverridable: true },
      { providerId: "claude-code", authMode: "oauth2", baseUrlOverridable: false },
    ];
    expect(personalApiKeyProviders(registry).map((p) => p.providerId)).toEqual(["openai"]);
  });
});

describe("personalApiKeyBody", () => {
  it("owns the credential by the caller, with no endpoint override", () => {
    expect(personalApiKeyBody({ providerId: "openai", label: "Perso", apiKey: "sk-test" })).toEqual(
      {
        providerId: "openai",
        label: "Perso",
        api_key: "sk-test",
        owner_type: "user",
      },
    );
  });
});

describe("ownPersonalCredentials", () => {
  const credentials: {
    id: string;
    owner_type: "org" | "user";
    owner_id: string | null;
  }[] = [
    { id: "mine", owner_type: "user", owner_id: "u_me" },
    { id: "theirs", owner_type: "user", owner_id: "u_other" },
    { id: "org", owner_type: "org", owner_id: null },
  ];

  it("keeps only the caller's personal credentials out of an org-wide list", () => {
    expect(ownPersonalCredentials(credentials, "u_me").map((c) => c.id)).toEqual(["mine"]);
  });

  it("keeps nothing while the caller is not known yet", () => {
    expect(ownPersonalCredentials(credentials, undefined)).toEqual([]);
  });
});

describe("modelsPaidByCaller", () => {
  it("keeps the models the caller's own credential pays for", () => {
    const models: { id: string; billed_to: "user" | "org" | null }[] = [
      { id: "paid_by_me", billed_to: "user" },
      { id: "paid_by_org", billed_to: "org" },
      { id: "unbound", billed_to: null },
    ];
    expect(modelsPaidByCaller(models).map((m) => m.id)).toEqual(["paid_by_me"]);
  });
});
