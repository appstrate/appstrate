// SPDX-License-Identifier: Apache-2.0

/**
 * What adding the checked models puts on the wire.
 *
 * One rule, three answers, and the question behind all of them is "can the
 * server resolve this itself on read?". A catalogued id sends nothing but its
 * name, so the weekly catalog refresh keeps reaching the row; a discovered one
 * sends only what the listing carried, never a default; a searched one sends
 * everything including the rate, because nothing else knows it.
 */

import { describe, it, expect } from "bun:test";
import { buildModelsBatchPayload } from "../model-pick-payload.ts";
import type { ModelPickRow } from "../model-source.ts";
import type { ModelFormProvider } from "../model-form-payload.ts";

const OPENAI_COMPATIBLE: ModelFormProvider = {
  providerId: "openai-compatible",
  authMode: "api_key",
  baseUrlOverridable: true,
};
const ANTHROPIC: ModelFormProvider = {
  providerId: "anthropic",
  authMode: "api_key",
  baseUrlOverridable: false,
};

const SAVED_KEY = {
  provider: OPENAI_COMPATIBLE,
  selectedCredentialId: "cred_1",
  inlineApiKey: "",
  baseUrl: "http://localhost:11434/v1",
};

function row(overrides: Partial<ModelPickRow> & { id: string; origin: ModelPickRow["origin"] }) {
  return {
    label: null,
    contextWindow: null,
    maxTokens: null,
    input: null,
    reasoning: null,
    source: null,
    cost: null,
    featured: false,
    ...overrides,
  } satisfies ModelPickRow;
}

describe("buildModelsBatchPayload — a catalogued pick", () => {
  it("sends the id and nothing else, so the catalog keeps answering", () => {
    // Every value the row carries came from the catalog in the first place;
    // writing them back would freeze them against the weekly refresh.
    const result = buildModelsBatchPayload({
      ...SAVED_KEY,
      provider: ANTHROPIC,
      rows: [
        row({
          id: "claude-sonnet-4-5-20250929",
          origin: "catalog",
          label: "Claude Sonnet 4.5",
          contextWindow: 200000,
          maxTokens: 64000,
          input: ["text", "image"],
          reasoning: true,
          source: "catalog",
          featured: true,
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.models).toEqual([{ modelId: "claude-sonnet-4-5-20250929" }]);
  });
});

describe("buildModelsBatchPayload — a discovered pick", () => {
  it("writes what the listing described, since no catalog stands behind it", () => {
    const result = buildModelsBatchPayload({
      ...SAVED_KEY,
      rows: [
        row({
          id: "qwen3:8b",
          origin: "discover",
          label: "Qwen 3 8B",
          contextWindow: 32768,
          maxTokens: 8192,
          input: ["text", "image"],
          reasoning: true,
          source: "endpoint",
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.models).toEqual([
      {
        label: "Qwen 3 8B",
        modelId: "qwen3:8b",
        input: ["text", "image"],
        contextWindow: 32768,
        maxTokens: 8192,
        reasoning: true,
      },
    ]);
  });

  it("never sends a rate a discovery carried, even by accident", () => {
    // `discover` deliberately returns no cost; a row that somehow held one is
    // still not priced at whatever endpoint served it.
    const result = buildModelsBatchPayload({
      ...SAVED_KEY,
      rows: [row({ id: "qwen3:8b", origin: "discover", cost: { input: 1.25, output: 10 } })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("cost" in result.data.models[0]!).toBe(false);
  });

  it("sends nothing but the id for a model nobody described", () => {
    // No override is invented, so the row reads as "auto" when edited rather
    // than as an answer the operator never gave.
    const result = buildModelsBatchPayload({
      ...SAVED_KEY,
      rows: [row({ id: "mystery", origin: "discover" })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.models).toEqual([{ modelId: "mystery" }]);
  });

  it("keeps a reported false and drops an empty modality list", () => {
    // The server refuses an empty array — it describes no model at all.
    const result = buildModelsBatchPayload({
      ...SAVED_KEY,
      rows: [row({ id: "llama3", origin: "discover", input: [], reasoning: false })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.models[0]).toEqual({ modelId: "llama3", reasoning: false });
  });
});

describe("buildModelsBatchPayload — a searched pick", () => {
  it("persists everything the search brought, the rate included", () => {
    // OpenRouter has no vendored catalog, and its listing IS the billing rate.
    const result = buildModelsBatchPayload({
      ...SAVED_KEY,
      provider: ANTHROPIC,
      rows: [
        row({
          id: "openai/gpt-5",
          origin: "search",
          label: "GPT-5",
          contextWindow: 400000,
          maxTokens: 128000,
          input: ["text", "image"],
          reasoning: true,
          source: "endpoint",
          cost: { input: 1.25, output: 10 },
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.models).toEqual([
      {
        label: "GPT-5",
        modelId: "openai/gpt-5",
        input: ["text", "image"],
        contextWindow: 400000,
        maxTokens: 128000,
        reasoning: true,
        cost: { input: 1.25, output: 10 },
      },
    ]);
  });
});

describe("buildModelsBatchPayload — the credential they all share", () => {
  const ROWS = [row({ id: "a", origin: "discover" }), row({ id: "b", origin: "discover" })];

  it("binds every entry to the saved key that was picked", () => {
    const result = buildModelsBatchPayload({ ...SAVED_KEY, rows: ROWS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.credentialId).toBe("cred_1");
    expect(result.data.newCredential).toBeUndefined();
    expect(result.data.models).toHaveLength(2);
  });

  it("creates the typed key ONCE, for the whole batch", () => {
    const result = buildModelsBatchPayload({
      ...SAVED_KEY,
      selectedCredentialId: null,
      inlineApiKey: "sk-test",
      rows: ROWS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.credentialId).toBe("");
    expect(result.data.newCredential).toEqual({
      apiKey: "sk-test",
      providerId: "openai-compatible",
      baseUrlOverride: "http://localhost:11434/v1",
    });
  });

  it("omits the base-URL override for a provider that pins its own endpoint", () => {
    const result = buildModelsBatchPayload({
      ...SAVED_KEY,
      provider: ANTHROPIC,
      selectedCredentialId: null,
      inlineApiKey: "sk-ant-test",
      rows: ROWS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.newCredential).toEqual({
      apiKey: "sk-ant-test",
      providerId: "anthropic",
    });
  });

  it("refuses a batch with nothing checked", () => {
    expect(buildModelsBatchPayload({ ...SAVED_KEY, rows: [] })).toEqual({
      ok: false,
      field: "modelId",
      messageKey: "models.form.selectionRequired",
    });
  });

  it("refuses one with no key to open the endpoint", () => {
    expect(
      buildModelsBatchPayload({ ...SAVED_KEY, selectedCredentialId: null, rows: ROWS }),
    ).toEqual({
      ok: false,
      field: "credentialId",
      messageKey: "models.form.apiKeyRequired",
    });
  });
});
