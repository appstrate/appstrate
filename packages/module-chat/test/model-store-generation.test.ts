// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import type { ModelGenerationCapabilities } from "@appstrate/core/model-generation";
import {
  getCompatibleGenerationSettings,
  getGenerationSettings,
  setGenerationSettings,
  setActiveConversation,
  setModelCatalog,
  setSelectedModel,
} from "../src/ui/model-store.ts";

const SUPPORTED: ModelGenerationCapabilities = {
  temperature: "supported",
  reasoning: {
    supported: "supported",
    adaptive: false,
    levels: { high: "supported" },
  },
};

const NO_TEMPERATURE: ModelGenerationCapabilities = {
  ...SUPPORTED,
  temperature: "unsupported",
};

afterEach(() => {
  setActiveConversation(null);
  setSelectedModel(null);
  setGenerationSettings({});
  setModelCatalog([]);
});

describe("chat model generation settings", () => {
  it("removes stale settings when the selected model changes", () => {
    setModelCatalog([
      { id: "model-a", generation: SUPPORTED },
      { id: "model-b", generation: NO_TEMPERATURE },
    ]);
    setSelectedModel("model-a");
    setGenerationSettings({ temperature: 0.7, reasoningLevel: "high" });

    setSelectedModel("model-b");

    expect(getGenerationSettings()).toEqual({ reasoningLevel: "high" });
  });

  it("rechecks compatibility immediately before a request is built", () => {
    setModelCatalog([{ id: "model", generation: NO_TEMPERATURE }]);
    setSelectedModel("model");
    setGenerationSettings({ temperature: 0.4 });

    expect(getCompatibleGenerationSettings()).toEqual({});
  });
});
