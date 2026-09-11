// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `describeServedModel` — how a bare id a custom endpoint
 * enumerates gets described, from the hints its listing published and from the
 * vendored catalog.
 *
 * Three lookup phases, in order: the provider's own catalog
 * (`catalogProviderId ?? providerId`), every catalog by exact id, every
 * catalog by the id with one leading `<vendor>/` segment stripped. The
 * ordering is the whole point — a self-hosted endpoint and a vendor can both
 * publish `gpt-4o`, and the provider's own catalog is the one that describes
 * what it actually serves.
 *
 * A hint wins over the catalog for its own field and sets `source: "endpoint"`;
 * `label` is catalog-only. Cost is never part of the answer: an endpoint
 * serving a vendor's model id is not billed at the vendor's rate.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { describeServedModel } from "../../src/services/model-providers/model-metadata.ts";
import { registerModelProvider } from "../../src/services/model-providers/registry.ts";
import { registerCatalog, lookupCatalogModel } from "../../src/services/pricing-catalog.ts";
import { seedTestModelProviders } from "../helpers/model-providers.ts";
import type { CatalogModelEntry } from "@appstrate/shared-types";

const OWN_CATALOG = "test-describe-own";
const OTHER_CATALOG = "test-describe-other";
const PROVIDER = "test-describe-provider";
/** Deliberately never registered — exercises the fallback to `providerId`. */
const UNKNOWN_PROVIDER = "test-describe-unregistered";

const ownEntry: CatalogModelEntry = {
  label: "Own Catalog Model",
  contextWindow: 1000,
  maxTokens: 100,
  capabilities: ["text", "image", "reasoning"],
  cost: { input: 1, output: 2 },
};

const otherEntry: CatalogModelEntry = {
  label: "Other Catalog Model",
  contextWindow: 2000,
  maxTokens: 200,
  capabilities: ["text"],
  cost: { input: 3, output: 4 },
};

beforeAll(() => {
  // Baseline first, synthetic definitions on top — same discipline as the
  // other registry-touching unit tests (`bun test` shares one process).
  seedTestModelProviders();
  // OTHER is registered BEFORE OWN so the cross-catalog scan would reach it
  // first: a lookup that skipped the own-catalog phase returns "Other".
  registerCatalog(OTHER_CATALOG, { "shared-id": otherEntry, "other-only": otherEntry });
  registerCatalog(OWN_CATALOG, { "shared-id": ownEntry });
  registerModelProvider({
    providerId: PROVIDER,
    displayName: "Synthetic Describe",
    iconUrl: "openai",
    description: "Synthetic provider for the served-model description lookup.",
    apiShape: "openai-completions",
    defaultBaseUrl: "https://describe.example.test",
    baseUrlOverridable: true,
    authMode: "api_key",
    catalogProviderId: OWN_CATALOG,
    featuredModels: [],
  });
});

afterAll(() => {
  seedTestModelProviders();
});

describe("describeServedModel", () => {
  it("prefers the provider's own catalog over every other catalog", () => {
    expect(describeServedModel(PROVIDER, "shared-id")).toEqual({
      label: "Own Catalog Model",
      contextWindow: 1000,
      maxTokens: 100,
      input: ["text", "image"],
      reasoning: true,
      source: "catalog",
      endpointCapabilities: {},
    });
  });

  it("falls back to an exact id in any other catalog", () => {
    expect(describeServedModel(UNKNOWN_PROVIDER, "other-only")).toEqual({
      label: "Other Catalog Model",
      contextWindow: 2000,
      maxTokens: 200,
      input: ["text"],
      reasoning: false,
      source: "catalog",
      endpointCapabilities: {},
    });
  });

  it("strips one leading vendor segment when the full id matches nothing", () => {
    expect(describeServedModel(UNKNOWN_PROVIDER, "some-vendor/other-only").label).toBe(
      "Other Catalog Model",
    );
  });

  it("describes nothing when the id is in no catalog", () => {
    expect(describeServedModel(PROVIDER, "qwen3:8b")).toEqual({
      label: null,
      contextWindow: null,
      maxTokens: null,
      input: null,
      reasoning: null,
      source: null,
      endpointCapabilities: {},
    });
  });

  it("never carries the catalog's cost into the description", () => {
    // A self-hosted endpoint serving a vendor id is not billed at the vendor's
    // rate; a price copied here would land in the usage ledger as fact.
    const described = describeServedModel(PROVIDER, "shared-id");
    expect(described).not.toHaveProperty("cost");
    expect(JSON.stringify(described)).not.toContain("cost");
    // The catalog entry it was built from does price the model — without this,
    // the assertion above would pass on a catalog that prices nothing.
    expect(lookupCatalogModel(OWN_CATALOG, "shared-id")?.cost).toBeDefined();
  });

  it("reads a real vendored catalog entry (openai/gpt-4o)", () => {
    // Compare against what the catalog HOLDS, not a transcription of it:
    // `src/data/pricing/*` is refreshed weekly by a bot.
    const entry = lookupCatalogModel("openai", "gpt-4o");
    expect(entry).toBeDefined();
    expect(describeServedModel("openai", "openai/gpt-4o")).toEqual({
      label: entry!.label,
      contextWindow: entry!.contextWindow,
      maxTokens: entry!.maxTokens,
      input: entry!.capabilities.filter((c) => c === "text" || c === "image"),
      reasoning: entry!.capabilities.includes("reasoning"),
      source: "catalog",
      endpointCapabilities: {},
    });
  });

  it("lets a hint override the catalog field by field, keeping the catalog label", () => {
    expect(describeServedModel(PROVIDER, "shared-id", { contextWindow: 262144 })).toEqual({
      label: "Own Catalog Model",
      // The endpoint knows what it was actually started with; the catalog
      // describes the vendor's hosted variant of the same id.
      contextWindow: 262144,
      maxTokens: 100,
      input: ["text", "image"],
      reasoning: true,
      source: "endpoint",
      endpointCapabilities: { contextWindow: 262144 },
    });
  });

  it("describes an id no catalog knows from its hints alone", () => {
    expect(
      describeServedModel(PROVIDER, "qwen3:8b", { contextWindow: 40960, input: ["text"] }),
    ).toEqual({
      label: null,
      contextWindow: 40960,
      maxTokens: null,
      input: ["text"],
      reasoning: null,
      source: "endpoint",
      endpointCapabilities: { contextWindow: 40960, input: ["text"] },
    });
  });

  it("stays on the catalog when the listing published no hint", () => {
    expect(describeServedModel(PROVIDER, "shared-id", {}).source).toBe("catalog");
  });
});
