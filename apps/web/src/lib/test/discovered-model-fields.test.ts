// SPDX-License-Identifier: Apache-2.0

/**
 * What adding detected models puts on the wire.
 *
 * Only what the description carried ships: a field the listing and the catalog
 * both left null is omitted, never filled with a default, so a model nobody
 * described stores no override and its row keeps resolving as "auto".
 */

import { describe, it, expect } from "bun:test";
import { buildDiscoveredModelsPayload } from "../discovered-model-fields.ts";
import type { ModelFormProvider } from "../model-form-payload.ts";
import type { DiscoveredModel } from "../../hooks/use-model-provider-credentials.ts";

function discovered(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: "qwen3:8b",
    label: "Qwen 3 8B",
    context_window: 32768,
    max_tokens: 8192,
    input: ["text", "image"],
    reasoning: true,
    source: "endpoint",
    ...overrides,
  };
}

/**
 * What adding several detected models at once puts on the wire: one entry per
 * checked model, and the ONE credential they all run on — there is no bulk
 * create, so the caller posts each entry itself.
 */
describe("buildDiscoveredModelsPayload", () => {
  const OPENAI_COMPATIBLE: ModelFormProvider = {
    providerId: "openai-compatible",
    authMode: "api_key",
    baseUrlOverridable: true,
  };
  const SAVED_KEY = {
    provider: OPENAI_COMPATIBLE,
    selectedCredentialId: "cred_1",
    inlineApiKey: "",
    baseUrl: "http://localhost:11434/v1",
  };
  const LLAMA = discovered({
    id: "llama3",
    label: null,
    context_window: 8192,
    max_tokens: null,
    input: ["text"],
    reasoning: false,
    source: "catalog",
  });

  it("describes every checked model, all bound to the same key", () => {
    const result = buildDiscoveredModelsPayload({ ...SAVED_KEY, models: [discovered(), LLAMA] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.credentialId).toBe("cred_1");
    expect(result.data.newCredential).toBeUndefined();
    expect(result.data.models).toEqual([
      {
        label: "Qwen 3 8B",
        modelId: "qwen3:8b",
        input: ["text", "image"],
        contextWindow: 32768,
        maxTokens: 8192,
        reasoning: true,
      },
      // No name in the listing, and no max output tokens either: both are left
      // for the server to derive rather than invented here.
      { modelId: "llama3", input: ["text"], contextWindow: 8192, reasoning: false },
    ]);
  });

  it("sends nothing but the id for a model nobody described", () => {
    // Neither the listing nor the catalog knew it: no override is invented,
    // so the row reads as "auto" when edited rather than as an answer given.
    const result = buildDiscoveredModelsPayload({
      ...SAVED_KEY,
      models: [
        discovered({
          label: null,
          context_window: null,
          max_tokens: null,
          input: null,
          reasoning: null,
          source: null,
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.models).toEqual([{ modelId: "qwen3:8b" }]);
  });

  it("keeps a reported false and drops an empty modality list", () => {
    const result = buildDiscoveredModelsPayload({
      ...SAVED_KEY,
      models: [discovered({ input: [], reasoning: false })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.models[0]).toMatchObject({ reasoning: false });
    expect("input" in result.data.models[0]!).toBe(false);
  });

  it("creates the typed key ONCE, for the whole batch", () => {
    const result = buildDiscoveredModelsPayload({
      ...SAVED_KEY,
      selectedCredentialId: null,
      inlineApiKey: "sk-test",
      models: [discovered(), LLAMA],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.credentialId).toBe("");
    expect(result.data.newCredential).toEqual({
      apiKey: "sk-test",
      providerId: "openai-compatible",
      baseUrlOverride: "http://localhost:11434/v1",
    });
    expect(result.data.models).toHaveLength(2);
  });

  it("refuses a batch with nothing checked", () => {
    expect(buildDiscoveredModelsPayload({ ...SAVED_KEY, models: [] })).toEqual({
      ok: false,
      field: "modelId",
      messageKey: "models.form.selectionRequired",
    });
  });

  it("refuses one with no key to open the endpoint", () => {
    expect(
      buildDiscoveredModelsPayload({
        ...SAVED_KEY,
        selectedCredentialId: null,
        models: [discovered()],
      }),
    ).toEqual({
      ok: false,
      field: "credentialId",
      messageKey: "models.form.apiKeyRequired",
    });
  });
});
