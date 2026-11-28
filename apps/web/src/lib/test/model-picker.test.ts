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
  it("keeps the caller's own connections alone: the organization's name nothing, another member's serves nothing", () => {
    const result = pickerCredentials(
      [
        credential({ id: "org" }),
        credential({ id: "mine", owner_type: "user", owner_id: "u1" }),
        credential({ id: "theirs", owner_type: "user", owner_id: "u2" }),
      ],
      "u1",
    );
    expect(result.map((c) => c.id)).toEqual(["mine"]);
  });

  it("reads the models a connection serves off the server, its configuration and its health", () => {
    const [subscription] = pickerCredentials(
      [
        credential({
          providerId: "claude-code",
          authMode: "oauth2",
          owner_type: "user",
          owner_id: "u1",
          config_id: "cfg_1",
          needs_reconnection: true,
          serves_model_ids: ["mdl_sonnet"],
        }),
      ],
      "u1",
    );
    expect(subscription).toMatchObject({
      subscription: true,
      configId: "cfg_1",
      needsReconnection: true,
      modelIds: ["mdl_sonnet"],
    });
  });
});
