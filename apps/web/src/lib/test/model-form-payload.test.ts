// SPDX-License-Identifier: Apache-2.0

/**
 * What the model form actually puts on the wire.
 *
 * Two things are pinned here. First, the omissions: a value the user never
 * touched must NOT be sent, so the server keeps resolving it from the pricing
 * catalog and a weekly refresh still reaches existing rows. Second, the
 * provider id — the form used to send a client-only `"__custom__"` sentinel for
 * a custom endpoint, which `POST /api/model-provider-credentials` answers with
 * `400 Unknown providerId`. Every payload must name a registry provider.
 */

import { describe, it, expect } from "bun:test";
import {
  buildModelFormPayload,
  type ModelFormFields,
  type ModelFormPayloadInput,
  type ModelFormProvider,
} from "../model-form-payload.ts";
import { CUSTOM_ID } from "../provider-registry-helpers.ts";

const ANTHROPIC: ModelFormProvider = {
  providerId: "anthropic",
  authMode: "api_key",
  baseUrlOverridable: false,
};
const OPENAI_COMPATIBLE: ModelFormProvider = {
  providerId: "openai-compatible",
  authMode: "api_key",
  baseUrlOverridable: true,
};
const CLAUDE_CODE: ModelFormProvider = {
  providerId: "claude-code",
  authMode: "oauth2",
  baseUrlOverridable: false,
};

function fields(overrides: Partial<ModelFormFields> = {}): ModelFormFields {
  return {
    label: "",
    apiShape: "",
    baseUrl: "",
    modelId: "",
    credentialId: "",
    inlineApiKey: "",
    inputText: true,
    inputImage: false,
    contextWindow: "",
    maxTokens: "",
    reasoning: false,
    ...overrides,
  };
}

function build(input: Partial<ModelFormPayloadInput> & { fields: ModelFormFields }) {
  return buildModelFormPayload({
    dirtyFields: {},
    provider: ANTHROPIC,
    importedCost: null,
    ...input,
  });
}

/** A preset picked from the catalog: every field seeded, nothing edited. */
const PRESET_FIELDS = fields({
  label: "Claude Sonnet 4.5",
  apiShape: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  modelId: "claude-sonnet-4-5-20250929",
  credentialId: "cred_1",
  contextWindow: "200000",
  maxTokens: "64000",
});

describe("buildModelFormPayload — catalog preset", () => {
  it("sends the binding only, leaving every catalog-derivable field to the server", () => {
    const result = build({ fields: PRESET_FIELDS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      modelId: "claude-sonnet-4-5-20250929",
      credentialId: "cred_1",
    });
  });

  it("sends a catalog-derivable field once the user edits it", () => {
    const result = build({
      fields: { ...PRESET_FIELDS, contextWindow: "120000" },
      dirtyFields: { contextWindow: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.contextWindow).toBe(120000);
    // The neighbouring field stayed untouched, so it stays off the wire.
    expect(result.data.maxTokens).toBeUndefined();
  });
});

describe("buildModelFormPayload — custom endpoint", () => {
  const result = build({
    provider: OPENAI_COMPATIBLE,
    fields: fields({
      label: "Local Qwen",
      apiShape: "openai-completions",
      baseUrl: "http://localhost:11434/v1",
      modelId: "qwen3:8b",
      inlineApiKey: "sk-test",
      contextWindow: "32768",
      maxTokens: "8192",
      reasoning: true,
    }),
    dirtyFields: {
      label: true,
      contextWindow: true,
      maxTokens: true,
      reasoning: true,
      inputText: true,
    },
  });

  it("creates the credential against the registry provider, at the typed base URL", () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.newCredential).toEqual({
      apiKey: "sk-test",
      providerId: "openai-compatible",
      baseUrlOverride: "http://localhost:11434/v1",
    });
    // The credential does not exist yet — the caller fills this in from the
    // create response before posting the model.
    expect(result.data.credentialId).toBe("");
  });

  it("sends everything the operator typed, none of it being catalog-derivable", () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.label).toBe("Local Qwen");
    expect(result.data.modelId).toBe("qwen3:8b");
    expect(result.data.contextWindow).toBe(32768);
    expect(result.data.maxTokens).toBe(8192);
    expect(result.data.reasoning).toBe(true);
    expect(result.data.input).toEqual(["text"]);
  });

  it("never puts the client-side custom sentinel on the wire", () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.data)).not.toContain(CUSTOM_ID);
  });

  it("omits the base-URL override for a provider that pins its own endpoint", () => {
    const pinned = build({
      provider: ANTHROPIC,
      fields: fields({
        modelId: "claude-sonnet-4-5-20250929",
        baseUrl: "https://api.anthropic.com",
        inlineApiKey: "sk-ant-test",
      }),
    });
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;
    expect(pinned.data.newCredential).toEqual({
      apiKey: "sk-ant-test",
      providerId: "anthropic",
    });
  });
});

describe("buildModelFormPayload — missing credential", () => {
  it("refuses an OAuth provider with no connection selected", () => {
    const result = build({
      provider: CLAUDE_CODE,
      fields: fields({ modelId: "claude-sonnet-4-5-20250929" }),
    });
    expect(result).toEqual({
      ok: false,
      field: "credentialId",
      messageKey: "models.form.connectionRequired",
    });
  });

  it("refuses an api-key provider with neither a selection nor an inline key", () => {
    const result = build({
      fields: fields({ modelId: "claude-sonnet-4-5-20250929" }),
    });
    expect(result).toEqual({
      ok: false,
      field: "credentialId",
      messageKey: "models.form.apiKeyRequired",
    });
  });

  it("refuses an inline key typed before any provider is picked", () => {
    const result = build({
      provider: undefined,
      fields: fields({ modelId: "qwen3:8b", inlineApiKey: "sk-test" }),
    });
    expect(result.ok).toBe(false);
  });
});
