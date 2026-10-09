// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  checkSystemModels,
  declaredSystemModels,
  registryOffers,
  type Offers,
} from "../verify-system-models.ts";
import { seedTestModelProviders } from "../../apps/api/test/helpers/model-providers.ts";

const KEYS = [
  {
    id: "ds",
    providerId: "deepseek",
    apiKey: "sk-secret",
    models: [
      { id: "sys-flash", modelId: "deepseek-v4-flash", aliased: true },
      { modelId: "deepseek-flash", enabled: false },
      { label: "no model id" },
    ],
  },
  { id: "gone", providerId: "gone-module", apiKey: "sk-other", models: [{ modelId: "x" }] },
  { id: "no-models", providerId: "openai", apiKey: "sk-other" },
  "not an object",
];

describe("declaredSystemModels", () => {
  it("reads every declared model, enabled or not, and keeps no key", () => {
    const models = declaredSystemModels(KEYS);
    expect(models).toEqual([
      { keyId: "ds", providerId: "deepseek", modelId: "deepseek-v4-flash" },
      { keyId: "ds", providerId: "deepseek", modelId: "deepseek-flash" },
      { keyId: "gone", providerId: "gone-module", modelId: "x" },
    ]);
    expect(JSON.stringify(models)).not.toContain("sk-");
  });
});

describe("checkSystemModels", () => {
  it("splits the models the boot refuses from the ones it skips", () => {
    const offers: Offers = (providerId, modelId) =>
      providerId === "deepseek" ? modelId === "deepseek-flash" : null;
    expect(checkSystemModels(KEYS, offers)).toEqual({
      outside: [{ keyId: "ds", providerId: "deepseek", modelId: "deepseek-v4-flash" }],
      unregistered: [{ keyId: "gone", providerId: "gone-module", modelId: "x" }],
    });
  });

  describe("against the platform registry (Pi's offer)", () => {
    beforeAll(() => seedTestModelProviders());
    afterAll(() => seedTestModelProviders());

    it("refuses production's deepseek-v4-flash and accepts its replacement deepseek-flash", () => {
      expect(registryOffers("deepseek", "deepseek-v4-flash")).toBe(false);
      expect(registryOffers("deepseek", "deepseek-flash")).toBe(true);
      expect(registryOffers("openai-compatible", "anything")).toBe(true);
      expect(registryOffers("gone-module", "x")).toBeNull();
    });
  });
});
