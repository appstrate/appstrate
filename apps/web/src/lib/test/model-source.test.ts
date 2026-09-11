// SPDX-License-Identifier: Apache-2.0

/**
 * Which listing answers for a provider, and the one row shape it produces.
 *
 * The rule has to be readable without the form: two registry facts and one
 * provider id decide it, and everything below the rule — the badges, the
 * grouping, how much of a row reaches the wire — reads off `origin`.
 */

import { describe, it, expect } from "bun:test";
import {
  catalogRows,
  discoveredRows,
  filterRows,
  idOnlyRow,
  modelSource,
  searchRows,
} from "../model-source.ts";
import type { DiscoveredModel } from "../../hooks/use-model-provider-credentials.ts";

const CATALOG_ENTRY = {
  id: "claude-sonnet-4-5-20250929",
  label: "Claude Sonnet 4.5",
  contextWindow: 200000,
  maxTokens: 64000,
  capabilities: ["text", "image", "reasoning"],
  featured: true,
};

describe("modelSource", () => {
  it("names no source until a provider is picked", () => {
    expect(modelSource(undefined)).toBeNull();
  });

  it("sends OpenRouter to the live search, catalog or not", () => {
    // The one provider id compared by name, and for a billing reason: its
    // listing carries the per-token cost no other listing returns.
    expect(modelSource({ providerId: "openrouter", authMode: "api_key", models: [] })).toBe(
      "search",
    );
    expect(
      modelSource({ providerId: "openrouter", authMode: "api_key", models: [CATALOG_ENTRY] }),
    ).toBe("search");
  });

  it("reads a provider's own catalog when it has one", () => {
    expect(
      modelSource({ providerId: "anthropic", authMode: "api_key", models: [CATALOG_ENTRY] }),
    ).toBe("catalog");
  });

  it("reads a subscription against the catalog even when it ships none", () => {
    // Its listing is what the plan serves, and `POST /discover` refuses to
    // spend a subscription token: the endpoint is never the answer here.
    expect(modelSource({ providerId: "codex", authMode: "oauth2", models: [] })).toBe("catalog");
  });

  it("asks the endpoint when nothing describes it", () => {
    // Every base-URL-overridable entry, and any future api-key provider that
    // ships no catalog — which today would offer nothing at all.
    expect(modelSource({ providerId: "openai-compatible", authMode: "api_key", models: [] })).toBe(
      "discover",
    );
  });
});

describe("catalogRows", () => {
  const [row] = catalogRows([CATALOG_ENTRY]);

  it("splits the capability list into modalities and the reasoning flag", () => {
    expect(row).toMatchObject({
      id: CATALOG_ENTRY.id,
      label: "Claude Sonnet 4.5",
      contextWindow: 200000,
      maxTokens: 64000,
      input: ["text", "image"],
      reasoning: true,
      source: "catalog",
      origin: "catalog",
      featured: true,
    });
  });

  it("carries no cost: a catalogued row is priced server-side on read", () => {
    expect(row!.cost).toBeNull();
  });

  it("reads an absent max-output as unknown rather than zero", () => {
    const [noMax] = catalogRows([{ ...CATALOG_ENTRY, maxTokens: undefined }]);
    expect(noMax!.maxTokens).toBeNull();
  });
});

describe("idOnlyRow", () => {
  it("keeps a served id the catalog never heard of offerable", () => {
    // A subscription can serve an id the vendored catalog has not caught up
    // with; dropping it would hide a model the plan actually allows.
    expect(idOnlyRow("claude-unreleased")).toEqual({
      id: "claude-unreleased",
      label: null,
      contextWindow: null,
      maxTokens: null,
      input: null,
      reasoning: null,
      source: null,
      endpointCapabilities: {},
      cost: null,
      origin: "catalog",
      featured: false,
    });
  });
});

describe("discoveredRows", () => {
  const listing: DiscoveredModel = {
    id: "qwen3:8b",
    label: "Qwen 3 8B",
    context_window: 32768,
    max_tokens: 8192,
    input: ["text"],
    reasoning: false,
    source: "endpoint",
    endpoint_capabilities: { context_window: 32768, reasoning: false },
  };

  it("carries the listing's own provenance through unchanged", () => {
    expect(discoveredRows([listing])[0]).toMatchObject({
      id: "qwen3:8b",
      label: "Qwen 3 8B",
      contextWindow: 32768,
      maxTokens: 8192,
      input: ["text"],
      reasoning: false,
      source: "endpoint",
      origin: "discover",
      endpointCapabilities: { contextWindow: 32768, reasoning: false },
    });
  });

  it("claims nothing for a model the listing did not describe", () => {
    const bare = discoveredRows([
      {
        ...listing,
        label: null,
        context_window: null,
        max_tokens: null,
        input: null,
        source: null,
        endpoint_capabilities: {},
      },
    ])[0];
    expect(bare).toMatchObject({ label: null, contextWindow: null, input: null, source: null });
  });
});

describe("searchRows", () => {
  it("keeps the rate, which is the whole reason this source exists", () => {
    expect(
      searchRows([
        {
          id: "openai/gpt-5",
          name: "GPT-5",
          contextWindow: 400000,
          maxTokens: 128000,
          input: ["text", "image"],
          reasoning: true,
          cost: { input: 1.25, output: 10 },
        },
      ])[0],
    ).toMatchObject({
      id: "openai/gpt-5",
      label: "GPT-5",
      cost: { input: 1.25, output: 10 },
      source: "endpoint",
      origin: "search",
    });
  });
});

describe("filterRows", () => {
  const rows = catalogRows([
    CATALOG_ENTRY,
    { ...CATALOG_ENTRY, id: "claude-opus-5", label: "Opus" },
  ]);

  it("matches the id and the name alike", () => {
    expect(filterRows(rows, "opus").map((r) => r.id)).toEqual(["claude-opus-5"]);
    expect(filterRows(rows, "Sonnet").map((r) => r.id)).toEqual([CATALOG_ENTRY.id]);
  });

  it("shows everything when nothing is typed", () => {
    expect(filterRows(rows, "  ")).toHaveLength(2);
  });
});
