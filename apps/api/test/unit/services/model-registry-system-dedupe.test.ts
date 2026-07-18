// SPDX-License-Identifier: Apache-2.0

/**
 * Regression: a duplicate `SYSTEM_PROVIDER_KEYS` id must be rejected BEFORE the
 * mapper runs, so the losing entry's nested models never leak into
 * `systemModels` while its credential is dropped.
 *
 * `initSystemModelProviderKeys` builds the credential map via the shared
 * `loadSystemRegistry` skeleton, but populates the nested model map as a SIDE
 * EFFECT inside `toDefinition`. Without a pre-map dedupe, a duplicate id would
 * skip the credential yet still inject its models — leaving the two maps
 * inconsistent (a model pointing at a credentialId absent from the credential
 * map). The `idOf` pre-map dedupe closes that.
 */

import { describe, it, expect, afterAll } from "bun:test";
import {
  initSystemModelProviderKeys,
  getSystemModels,
  getSystemModelProviderCredentials,
} from "../../../src/services/model-registry.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";

describe("initSystemModelProviderKeys — duplicate id dedupe (pre-side-effect)", () => {
  afterAll(() => {
    // This file mutates the module-static system registries; restore an empty
    // system-keys state and re-seed the provider baseline so later files in the
    // same `bun test` process aren't poisoned.
    initSystemModelProviderKeys([]);
    seedTestModelProviders();
  });

  it("drops the duplicate entry whole — its models never reach systemModels", () => {
    seedTestModelProviders(); // ensures the `test-apikey` providerId resolves

    initSystemModelProviderKeys([
      {
        id: "dup",
        providerId: "test-apikey",
        apiKey: "key-winner",
        models: [{ id: "model-winner", modelId: "m1" }],
      },
      {
        // Same id → must be skipped BEFORE its models are parsed.
        id: "dup",
        providerId: "test-apikey",
        apiKey: "key-loser",
        models: [{ id: "model-loser", modelId: "m2" }],
      },
    ]);

    const creds = getSystemModelProviderCredentials();
    const models = getSystemModels();

    // Exactly one credential survives — the first (winner).
    expect(creds.has("dup")).toBe(true);
    expect(creds.get("dup")?.apiKey).toBe("key-winner");

    // The winner's model is present; the loser's model never leaked in.
    expect(models.has("model-winner")).toBe(true);
    expect(models.has("model-loser")).toBe(false);

    // Every system model points at a credential that actually exists.
    for (const m of models.values()) {
      expect(creds.has(m.credentialId)).toBe(true);
    }
  });
});
