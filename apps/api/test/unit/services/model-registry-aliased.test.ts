// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1 (model alias): `SYSTEM_PROVIDER_KEYS` model entries carry an optional
 * `aliased` flag. When true, the entry's `id` is a public alias and the real
 * binding (`modelId`, `apiShape`, `baseUrl`, `apiKey`, `providerId`) is hidden
 * from user-facing surfaces (projection in Phase 2, sidecar swap in Phase 3).
 * Here we only assert the flag round-trips through the registry parse — absent
 * defaults to false; a non-aliased sibling under the same key stays false.
 */

import { describe, it, expect, afterAll } from "bun:test";
import {
  initSystemModelProviderKeys,
  getSystemModels,
} from "../../../src/services/model-registry.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";

describe("initSystemModelProviderKeys — aliased flag", () => {
  afterAll(() => {
    // Restore an empty system-keys state + re-seed the provider baseline so
    // later files in the same `bun test` process aren't poisoned (this file
    // mutates the module-static registries).
    initSystemModelProviderKeys([]);
    seedTestModelProviders();
  });

  it("parses `aliased: true` into ModelDefinition and defaults absent/false to false", () => {
    seedTestModelProviders(); // ensures the `test-apikey` providerId resolves

    initSystemModelProviderKeys([
      {
        id: "vanity-key",
        providerId: "test-apikey",
        apiKey: "sk-secret",
        models: [
          // Public alias — real backing hidden. An alias MUST carry an explicit
          // label (a derived one would name the backing) and use a body-`model`
          // protocol; the registry skips aliases that violate either invariant.
          {
            id: "appstrate-medium",
            modelId: "deepseek-chat",
            label: "Appstrate Medium",
            aliased: true,
          },
          // Sibling under the same key, explicitly not aliased.
          { id: "plain-model", modelId: "gpt-4o", aliased: false },
          // Flag omitted → defaults to false.
          { id: "default-model", modelId: "claude-opus-4-8" },
        ],
      },
    ]);

    const models = getSystemModels();

    const aliased = models.get("appstrate-medium");
    expect(aliased).toBeDefined();
    expect(aliased?.aliased).toBe(true);
    // The real backing id is retained server-side (resolution + ledger).
    expect(aliased?.modelId).toBe("deepseek-chat");

    expect(models.get("plain-model")?.aliased).toBe(false);
    expect(models.get("default-model")?.aliased).toBe(false);
  });

  it("skips an aliased entry that lacks an explicit label (would leak the backing)", () => {
    seedTestModelProviders();
    initSystemModelProviderKeys([
      {
        id: "vanity-key-2",
        providerId: "test-apikey",
        apiKey: "sk-secret",
        models: [
          // aliased but no label → the derived label would name the backing →
          // the registry drops it (logged) rather than register a leaky alias.
          { id: "leaky-alias", modelId: "deepseek-chat", aliased: true },
          // a well-formed sibling under the same key still registers.
          { id: "ok-alias", modelId: "gpt-4o", label: "OK", aliased: true },
        ],
      },
    ]);

    const models = getSystemModels();
    expect(models.get("leaky-alias")).toBeUndefined();
    expect(models.get("ok-alias")?.aliased).toBe(true);
  });
});
