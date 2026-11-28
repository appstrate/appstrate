// SPDX-License-Identifier: Apache-2.0

/**
 * What the model form puts on the wire. Pinned: the omissions (a value the
 * operator never answered is left to the catalog), the `null` clears of an
 * edit, and the entries a model list ships.
 */

import { describe, it, expect } from "bun:test";
import {
  buildModelFormPayload,
  manualRow,
  rowToEntry,
  modelFormRefusals,
  type ModelFormData,
  type ModelFormFields,
  type ModelFormModelEntry,
  type ModelFormPayloadInput,
} from "../model-form-payload.ts";
import type { ModelPickRow } from "../model-source.ts";
import type { CatalogModelValues } from "../row-overrides-catalog.ts";

function fields(overrides: Partial<ModelFormFields> = {}): ModelFormFields {
  return {
    label: "",
    modelId: "",
    capabilitiesExplicit: false,
    inputText: true,
    inputImage: false,
    contextWindow: "",
    maxTokens: "",
    reasoning: false,
    ...overrides,
  };
}

function build(input: Partial<ModelFormPayloadInput> & { fields: ModelFormFields }): ModelFormData {
  return buildModelFormPayload({ dirtyFields: {}, capabilities: "auto", ...input });
}

/** A catalogued row: the fields describe it, but none of it is the operator's. */
const CATALOGUED_FIELDS = fields({
  label: "Claude Sonnet 4.5",
  modelId: "claude-sonnet-4-5-20250929",
  contextWindow: "200000",
  maxTokens: "64000",
});

describe("buildModelFormPayload — a catalogued model, toggle off", () => {
  it("clears the four, a no-op for a row that never overrode", () => {
    expect(build({ fields: CATALOGUED_FIELDS })).toEqual({
      modelId: "claude-sonnet-4-5-20250929",
      input: null,
      contextWindow: null,
      maxTokens: null,
      reasoning: null,
    });
  });
});

describe("buildModelFormPayload — capabilities", () => {
  const CUSTOM = fields({ modelId: "qwen3:8b" });

  const explicit = (overrides: Partial<ModelFormFields> = {}) =>
    build({
      fields: { ...CUSTOM, capabilitiesExplicit: true, ...overrides },
      capabilities: "explicit",
    });

  it("ships every answer once the operator takes the four questions on", () => {
    expect(
      explicit({ inputImage: true, contextWindow: "32768", maxTokens: "8192", reasoning: true }),
    ).toMatchObject({
      input: ["text", "image"],
      contextWindow: 32768,
      maxTokens: 8192,
      reasoning: true,
    });
  });

  it("reads an unticked box as `false`, not as an unanswered question", () => {
    expect(explicit()).toMatchObject({ input: ["text"], reasoning: false });
  });

  it("clears the modalities when neither box is ticked (the server refuses an empty array)", () => {
    expect(explicit({ inputText: false, inputImage: false }).input).toBeNull();
  });

  it("sends only the limits actually filled in, and clears a blanked one", () => {
    expect(explicit({ contextWindow: "32768", maxTokens: "  " })).toMatchObject({
      contextWindow: 32768,
      maxTokens: null,
    });
  });

  it("clears every stored override when the toggle is off", () => {
    const data = build({
      fields: { ...CUSTOM, contextWindow: "32768", reasoning: true },
      capabilities: "auto",
    });
    expect(data).toMatchObject({
      input: null,
      contextWindow: null,
      maxTokens: null,
      reasoning: null,
    });
  });
});

describe("buildModelFormPayload — explicit capabilities on a catalogued model", () => {
  const SONNET = {
    contextWindow: 200000,
    maxTokens: 64000,
    capabilities: ["text", "image", "reasoning"],
  };
  /** The form as the edit opens it: RESOLVED values, toggle then ticked. */
  const PREFILLED = fields({
    modelId: "claude-sonnet-4-5-20250929",
    capabilitiesExplicit: true,
    inputText: true,
    inputImage: true,
    contextWindow: "200000",
    maxTokens: "64000",
    reasoning: true,
  });

  const edit = (
    overrides: Partial<ModelFormFields> = {},
    catalogEntry: CatalogModelValues = SONNET,
  ) =>
    build({
      fields: { ...PREFILLED, ...overrides },
      capabilities: "explicit",
      catalogEntry,
    });

  it("ships the one modality the operator changed, and clears the three it did not", () => {
    // Sending the catalog's own numbers back would freeze them as overrides.
    expect(edit({ inputImage: false })).toEqual({
      modelId: "claude-sonnet-4-5-20250929",
      input: ["text"],
      contextWindow: null,
      maxTokens: null,
      reasoning: null,
    });
  });

  it("ships the limit that differs, and leaves the rest to the catalog", () => {
    expect(edit({ contextWindow: "32768" })).toMatchObject({
      contextWindow: 32768,
      input: null,
      maxTokens: null,
      reasoning: null,
    });
  });

  it("ships all four for an endpoint no catalog describes", () => {
    const data = build({ fields: PREFILLED, capabilities: "explicit" });
    expect(data).toMatchObject({
      input: ["text", "image"],
      contextWindow: 200000,
      maxTokens: 64000,
      reasoning: true,
    });
  });

  it("reads a catalog entry with no max output as answering nothing for it", () => {
    const data = edit({}, { ...SONNET, maxTokens: null });
    expect(data.maxTokens).toBe(64000);
    expect(data.contextWindow).toBeNull();
  });
});

describe("buildModelFormPayload — the model's name", () => {
  const CUSTOM = fields({ modelId: "qwen3:8b" });
  const named = (label: string, dirty: boolean) =>
    build({
      fields: { ...CUSTOM, label },
      dirtyFields: dirty ? { label: true } : {},
    });

  it("omits it when untouched, so the saved name is kept", () => {
    expect("label" in named("Local Qwen", false)).toBe(false);
  });

  it("sends it, trimmed, once the operator types one", () => {
    expect(named("  Qwen local  ", true).label).toBe("Qwen local");
  });

  it("omits it when a name was typed then cleared again", () => {
    expect("label" in named("   ", true)).toBe(false);
  });
});

describe("modelFormRefusals", () => {
  const base = { modelId: "m", offeredIds: null };

  it("requires an id", () => {
    expect(modelFormRefusals({ ...base, modelId: "  " }).modelId).toBe(
      "common:validation.required",
    );
  });

  it("refuses a typed id a catalog provider does not offer — the server does too", () => {
    const catalog = { ...base, offeredIds: ["deepseek-v4-flash"] };
    expect(modelFormRefusals({ ...catalog, modelId: "deepseek-chat" }).modelId).toBe(
      "settings:models.form.modelNotOffered",
    );
    expect(modelFormRefusals({ ...catalog, modelId: " deepseek-v4-flash " }).modelId).toBeNull();
  });

  it("leaves a free-form provider's id alone", () => {
    expect(modelFormRefusals({ ...base, modelId: "anything" }).modelId).toBeNull();
  });
});

// --- rowToEntry ---

function row(overrides: Partial<ModelPickRow> & { id: string; origin: ModelPickRow["origin"] }) {
  return {
    label: null,
    contextWindow: null,
    maxTokens: null,
    input: null,
    reasoning: null,
    source: null,
    endpointCapabilities: {},
    cost: null,
    featured: false,
    ...overrides,
  } satisfies ModelPickRow;
}

const DESCRIBED: Partial<ModelPickRow> = {
  label: "Described",
  contextWindow: 32768,
  maxTokens: 8192,
  input: ["text", "image"],
  reasoning: true,
  cost: { input: 1.25, output: 10 },
};

describe("rowToEntry — what a row ships, per describer", () => {
  it.each<[string, ModelPickRow, ModelFormModelEntry]>([
    [
      "catalog: the id only, so the catalog keeps answering",
      row({ id: "m", origin: "catalog", ...DESCRIBED, source: "catalog", featured: true }),
      { modelId: "m" },
    ],
    [
      "discover: what the endpoint published, never its label nor the cost",
      row({
        id: "m",
        origin: "discover",
        ...DESCRIBED,
        source: "endpoint",
        endpointCapabilities: DESCRIBED,
      }),
      {
        modelId: "m",
        input: ["text", "image"],
        contextWindow: 32768,
        maxTokens: 8192,
        reasoning: true,
      },
    ],
    [
      "discover: the id only when a catalog entry, not the endpoint, described it",
      row({ id: "m", origin: "discover", ...DESCRIBED, source: "catalog" }),
      { modelId: "m" },
    ],
    [
      "discover: nothing but the id for a model nobody described",
      row({ id: "m", origin: "discover" }),
      { modelId: "m" },
    ],
    [
      "discover: a reported false is kept, an empty modality list is dropped",
      row({
        id: "m",
        origin: "discover",
        source: "endpoint",
        input: [],
        reasoning: false,
        endpointCapabilities: { input: [], reasoning: false },
      }),
      { modelId: "m", reasoning: false },
    ],
    [
      "discover: catalog display values never become overrides beside an endpoint hint",
      row({
        id: "m",
        origin: "discover",
        ...DESCRIBED,
        source: "endpoint",
        endpointCapabilities: { contextWindow: 32768, reasoning: false },
      }),
      { modelId: "m", contextWindow: 32768, reasoning: false },
    ],
    [
      "search: everything, the rate included",
      row({ id: "m", origin: "search", ...DESCRIBED, source: "endpoint" }),
      {
        label: "Described",
        modelId: "m",
        input: ["text", "image"],
        contextWindow: 32768,
        maxTokens: 8192,
        reasoning: true,
        cost: { input: 1.25, output: 10 },
      },
    ],
  ])("%s", (_name, picked, entry) => {
    expect(rowToEntry(picked)).toEqual(entry);
  });
});

describe("manualRow — an id typed into the model list", () => {
  const typed = (overrides: Partial<ModelFormFields> = {}) => manualRow(fields(overrides));

  it("ships the id alone when the operator answered nothing else", () => {
    const row = typed({ modelId: " llama3 " });
    expect(row).toMatchObject({ id: "llama3", label: null, origin: "manual" });
    expect(rowToEntry(row)).toEqual({ modelId: "llama3" });
  });

  it("ships the name when one is typed, for the server to keep", () => {
    expect(rowToEntry(typed({ modelId: "llama3", label: " Llama 3 " }))).toEqual({
      modelId: "llama3",
      label: "Llama 3",
    });
  });

  it("ships the limits and modalities the operator set, an unticked box included", () => {
    const row = typed({
      modelId: "llama3",
      capabilitiesExplicit: true,
      inputImage: true,
      contextWindow: "32768",
    });
    expect(rowToEntry(row)).toEqual({
      modelId: "llama3",
      input: ["text", "image"],
      contextWindow: 32768,
      reasoning: false,
    });
  });

  it("ignores the capability fields while the operator leaves them to the server", () => {
    const row = typed({ modelId: "llama3", inputImage: true, contextWindow: "32768" });
    expect(rowToEntry(row)).toEqual({ modelId: "llama3" });
  });
});
