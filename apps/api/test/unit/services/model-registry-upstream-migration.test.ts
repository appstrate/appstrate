// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, it } from "bun:test";
import {
  getSystemModels,
  initSystemModelProviderKeys,
} from "../../../src/services/model-registry.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";

describe("initSystemModelProviderKeys — deprecated upstream migration", () => {
  afterAll(() => {
    initSystemModelProviderKeys([]);
    seedTestModelProviders();
  });

  it("keeps the public preset stable while routing DeepSeek chat to v4 flash", () => {
    seedTestModelProviders();
    initSystemModelProviderKeys([
      {
        id: "deepseek-system",
        providerId: "deepseek",
        apiKey: "sk-system",
        models: [
          {
            id: "appstrate-medium",
            modelId: "deepseek-chat",
            label: "Appstrate Medium",
            aliased: true,
          },
        ],
      },
    ]);

    const model = getSystemModels().get("appstrate-medium");
    expect(model).toBeDefined();
    expect(model!.id).toBe("appstrate-medium");
    expect(model!.modelId).toBe("deepseek-v4-flash");
    expect(model!.aliased).toBe(true);
  });

  it("does not rewrite the same model id for a custom/BYOK-compatible provider", () => {
    seedTestModelProviders();
    initSystemModelProviderKeys([
      {
        id: "custom-system",
        providerId: "test-apikey",
        apiKey: "sk-system",
        models: [{ id: "legacy-compatible", modelId: "deepseek-chat" }],
      },
    ]);

    expect(getSystemModels().get("legacy-compatible")!.modelId).toBe("deepseek-chat");
  });
});
