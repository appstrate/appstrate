// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  checkSystemModels,
  declaredSystemModels,
  reachableSubscriptionTiers,
  registryOffers,
  type Offers,
} from "../verify-system-models.ts";
import { seedTestModelProviders } from "../../apps/api/test/helpers/model-providers.ts";
import { TEST_OAUTH_PROVIDER_ID } from "../../apps/api/test/helpers/test-oauth-provider.ts";
import {
  getModelProvider,
  listModelProviders,
} from "../../apps/api/src/services/model-providers/registry.ts";

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

describe("reachableSubscriptionTiers (#1552)", () => {
  beforeAll(() => seedTestModelProviders());
  afterAll(() => seedTestModelProviders());

  it("finds no reachable tier on the shipped subscription providers", () => {
    const shipped = listModelProviders().filter((d) =>
      ["codex", "claude-code"].includes(d.providerId),
    );
    expect(shipped).toHaveLength(2);
    expect(reachableSubscriptionTiers(shipped)).toEqual([]);
  });

  it("reports a tier below the context window on an oauth2 provider only", () => {
    // The synthetic `test-oauth` offers Pi's `openai` records: gpt-5.5-pro has
    // a tier above 272000 and a 1050000 context window.
    const testOAuth = getModelProvider(TEST_OAUTH_PROVIDER_ID)!;
    expect(reachableSubscriptionTiers([testOAuth])).toContainEqual({
      providerId: TEST_OAUTH_PROVIDER_ID,
      modelId: "gpt-5.5-pro",
      contextWindow: 1050000,
      inputTokensAbove: 272000,
    });
    expect(reachableSubscriptionTiers([{ ...testOAuth, authMode: "api_key" }])).toEqual([]);
  });
});
