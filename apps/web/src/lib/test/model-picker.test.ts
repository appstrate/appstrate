// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { pickerCredentials } from "../model-picker";
import type { ModelProviderCredentialInfo } from "../../hooks/use-model-provider-credentials";

const credential = (over: Partial<ModelProviderCredentialInfo>): ModelProviderCredentialInfo =>
  ({
    id: "c1",
    label: "Clé",
    providerId: "anthropic",
    authMode: "api_key",
    owner_type: "org",
    owner_id: null,
    serves_model_ids: [],
    ...over,
  }) as ModelProviderCredentialInfo;

describe("pickerCredentials", () => {
  it("keeps the organization's credentials and the caller's own, not another member's", () => {
    const result = pickerCredentials(
      [
        credential({ id: "org" }),
        credential({ id: "mine", owner_type: "user", owner_id: "u1" }),
        credential({ id: "theirs", owner_type: "user", owner_id: "u2" }),
      ],
      "u1",
    );
    expect(result.map((c) => [c.id, c.owner])).toEqual([
      ["org", "org"],
      ["mine", "me"],
    ]);
  });

  it("reads the models a credential serves off the server, and flags a subscription", () => {
    const [subscription] = pickerCredentials(
      [
        credential({
          providerId: "claude-code",
          authMode: "oauth2",
          owner_type: "user",
          owner_id: "u1",
          serves_model_ids: ["mdl_sonnet"],
        }),
      ],
      "u1",
    );
    expect(subscription).toMatchObject({ subscription: true, modelIds: ["mdl_sonnet"] });
  });
});
