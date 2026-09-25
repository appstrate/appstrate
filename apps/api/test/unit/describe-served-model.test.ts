// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `describeServedModel` — how a bare id an endpoint enumerates
 * gets described, from the hints its listing published and from the catalog
 * (Pi's registry).
 *
 * Three lookup phases, in order: the provider's own offer, every Pi provider
 * by exact id, every Pi provider by the id with one leading `<vendor>/`
 * segment stripped. The ordering is the whole point — two providers can both
 * serve `kimi-k2.6`, and the provider's own record is the one that describes
 * what it actually serves.
 *
 * A hint wins over the catalog for its own field and sets `source: "endpoint"`;
 * `label` is catalog-only. Cost is never part of the answer: an endpoint
 * serving a vendor's model id is not billed at the vendor's rate.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { describeServedModel } from "../../src/services/model-providers/model-metadata.ts";
import { getModelProvider } from "../../src/services/model-providers/registry.ts";
import { describeKnownModel, lookupCatalogModel } from "../../src/services/model-catalog.ts";
import { seedTestModelProviders } from "../helpers/model-providers.ts";

/** OpenCode Go serves `kimi-k2.6` with a smaller response cap than the first Pi record of it. */
const PROVIDER = "opencode-go";
const SHARED_ID = "kimi-k2.6";
/** Deliberately never registered — exercises the cross-provider fallback. */
const UNKNOWN_PROVIDER = "test-describe-unregistered";

beforeAll(() => seedTestModelProviders());
afterAll(() => seedTestModelProviders());

function own() {
  const entry = lookupCatalogModel(getModelProvider(PROVIDER)!, SHARED_ID);
  if (!entry) throw new Error(`${PROVIDER} does not offer ${SHARED_ID}`);
  return entry;
}

describe("describeServedModel", () => {
  it("prefers the provider's own offer over every other provider's record", () => {
    const entry = own();
    // Discriminating: the cross-provider record of the same id differs.
    expect(describeKnownModel(SHARED_ID)?.maxTokens).not.toBe(entry.maxTokens);
    expect(describeServedModel(PROVIDER, SHARED_ID)).toEqual({
      label: entry.label,
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      input: ["text", "image"],
      reasoning: true,
      source: "catalog",
      endpointCapabilities: {},
    });
  });

  it("falls back to an exact id any Pi provider records", () => {
    const known = describeKnownModel("claude-opus-5")!;
    expect(describeServedModel(UNKNOWN_PROVIDER, "claude-opus-5")).toEqual({
      label: known.label,
      contextWindow: known.contextWindow,
      maxTokens: known.maxTokens,
      input: ["text", "image"],
      reasoning: true,
      source: "catalog",
      endpointCapabilities: {},
    });
  });

  it("strips one leading vendor segment when the full id matches nothing", () => {
    expect(describeServedModel(UNKNOWN_PROVIDER, "some-vendor/claude-opus-5").label).toBe(
      "Claude Opus 5",
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
    const described = describeServedModel(PROVIDER, SHARED_ID);
    expect(described).not.toHaveProperty("cost");
    expect(JSON.stringify(described)).not.toContain("cost");
    // The entry it was built from does price the model — without this, the
    // assertion above would pass on a catalog that prices nothing.
    expect(own().cost).not.toBeNull();
  });

  it("lets a hint override the catalog field by field, keeping the catalog label", () => {
    const entry = own();
    expect(describeServedModel(PROVIDER, SHARED_ID, { contextWindow: 131072 })).toEqual({
      label: entry.label,
      // The endpoint knows what it was actually started with; the catalog
      // describes the vendor's hosted variant of the same id.
      contextWindow: 131072,
      maxTokens: entry.maxTokens,
      input: ["text", "image"],
      reasoning: true,
      source: "endpoint",
      endpointCapabilities: { contextWindow: 131072 },
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
    expect(describeServedModel(PROVIDER, SHARED_ID, {}).source).toBe("catalog");
  });
});
