// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { pickerCredentials } from "../model-picker";
import type {
  ModelProviderCredentialInfo,
  ProviderRegistryEntry,
} from "../../hooks/use-model-provider-credentials";

const credential = (over: Partial<ModelProviderCredentialInfo>): ModelProviderCredentialInfo =>
  ({
    id: "c1",
    label: "Clé",
    providerId: "anthropic",
    authMode: "api_key",
    owner_type: "org",
    owner_id: null,
    ...over,
  }) as ModelProviderCredentialInfo;

const registry = [
  { providerId: "anthropic", models: [{ id: "claude-sonnet" }, { id: "claude-opus" }] },
  { providerId: "claude-code", models: [{ id: "claude-sonnet" }] },
] as unknown as ProviderRegistryEntry[];

describe("pickerCredentials", () => {
  it("keeps the organization's credentials and the caller's own, not another member's", () => {
    const result = pickerCredentials(
      [
        credential({ id: "org" }),
        credential({ id: "mine", owner_type: "user", owner_id: "u1" }),
        credential({ id: "theirs", owner_type: "user", owner_id: "u2" }),
      ],
      registry,
      "u1",
    );
    expect(result.map((c) => [c.id, c.owner])).toEqual([
      ["org", "org"],
      ["mine", "me"],
    ]);
  });

  it("reads the models a credential serves off its provider, and flags a subscription", () => {
    const [subscription] = pickerCredentials(
      [
        credential({
          providerId: "claude-code",
          authMode: "oauth2",
          owner_type: "user",
          owner_id: "u1",
        }),
      ],
      registry,
      "u1",
    );
    expect(subscription).toMatchObject({ subscription: true, modelIds: ["claude-sonnet"] });
  });

  it("serves nothing when the provider is not in the registry", () => {
    const [unknown] = pickerCredentials([credential({ providerId: "nope" })], registry, "u1");
    expect(unknown!.modelIds).toEqual([]);
  });
});
