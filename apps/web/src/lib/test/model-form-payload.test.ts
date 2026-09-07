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
  toCreateModelBody,
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
    capabilitiesExplicit: false,
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
    // The default is the catalogued-preset arrangement: no capabilities
    // section was ever rendered, and the form is adding a row.
    capabilities: "hidden",
    isEdit: false,
    // The form passes the credential it could match against the picked
    // provider; unless a case says otherwise, that is the raw field.
    selectedCredentialId: input.fields.credentialId || null,
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

  it("clears nothing on an edit either — the row never overrode anything", () => {
    // The section is not rendered for a preset, so there is no answer to
    // record and, unlike the custom paths, nothing of the operator's to drop.
    const result = build({ fields: PRESET_FIELDS, isEdit: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      modelId: "claude-sonnet-4-5-20250929",
      credentialId: "cred_1",
    });
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
    dirtyFields: { label: true },
    capabilities: "explicit",
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

describe("buildModelFormPayload — capabilities", () => {
  const CUSTOM = fields({
    modelId: "qwen3:8b",
    baseUrl: "http://localhost:11434/v1",
    inlineApiKey: "sk-test",
  });
  /** The four the capabilities toggle owns, together. */
  const FOUR = ["input", "contextWindow", "maxTokens", "reasoning"] as const;

  const explicit = (overrides: Partial<ModelFormFields> = {}) =>
    build({
      provider: OPENAI_COMPATIBLE,
      fields: { ...CUSTOM, capabilitiesExplicit: true, ...overrides },
      capabilities: "explicit",
    });

  it("ships every answer once the operator takes the four questions on", () => {
    const result = explicit({
      inputImage: true,
      contextWindow: "32768",
      maxTokens: "8192",
      reasoning: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      input: ["text", "image"],
      contextWindow: 32768,
      maxTokens: 8192,
      reasoning: true,
    });
  });

  it("reads an unticked box as `false`, not as an unanswered question", () => {
    // The whole reason the toggle exists: with the section on screen, what is
    // shown IS what is saved — no dirty-tracking between the two.
    const result = explicit();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.input).toEqual(["text"]);
    expect(result.data.reasoning).toBe(false);
  });

  it("drops the modalities when neither box is ticked", () => {
    // An empty array describes no model at all and the server refuses it, so
    // the field is left out and the catalog answers for it.
    const result = explicit({ inputText: false, inputImage: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("input" in result.data).toBe(false);
  });

  it("sends only the limits actually filled in", () => {
    const result = explicit({ contextWindow: "32768", maxTokens: "  " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.contextWindow).toBe(32768);
    expect("maxTokens" in result.data).toBe(false);
  });

  it("clears a stored limit the operator blanked on an edit", () => {
    // The field being on screen and empty is the operator's answer: `null`
    // drops the override, where omitting it would silently keep the old value.
    const result = build({
      provider: OPENAI_COMPATIBLE,
      fields: { ...CUSTOM, capabilitiesExplicit: true, contextWindow: "", inputText: false },
      capabilities: "explicit",
      isEdit: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.contextWindow).toBeNull();
    expect(result.data.maxTokens).toBeNull();
    expect(result.data.input).toBeNull();
  });

  it("sends none of the four when the toggle is off on a create", () => {
    const result = build({
      provider: OPENAI_COMPATIBLE,
      fields: CUSTOM,
      capabilities: "auto",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const key of FOUR) expect(key in result.data).toBe(false);
  });

  it("clears every stored override when the toggle is off on an edit", () => {
    // `PATCH /api/models/{id}` reads `null` as "drop it and resolve from the
    // catalog again" — omitting would keep an override the operator just
    // declined to own.
    const result = build({
      provider: OPENAI_COMPATIBLE,
      fields: { ...CUSTOM, contextWindow: "32768", reasoning: true },
      capabilities: "auto",
      isEdit: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      input: null,
      contextWindow: null,
      maxTokens: null,
      reasoning: null,
    });
  });

  it("clears nothing on an edit the section never rendered for", () => {
    const result = build({
      provider: OPENAI_COMPATIBLE,
      fields: CUSTOM,
      capabilities: "hidden",
      isEdit: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const key of FOUR) expect(key in result.data).toBe(false);
  });
});

describe("buildModelFormPayload — OpenRouter import", () => {
  // No capabilities section is rendered for OpenRouter: the pick itself is the
  // explicit answer, so what the live API described has to reach the wire —
  // there is no vendored catalog behind it to resolve any of it on read.
  const result = build({
    provider: ANTHROPIC,
    fields: fields({
      modelId: "openai/gpt-5",
      label: "GPT-5",
      credentialId: "cred_1",
      capabilitiesExplicit: true,
      inputImage: true,
      contextWindow: "400000",
      maxTokens: "128000",
      reasoning: true,
    }),
    dirtyFields: { label: true },
    capabilities: "explicit",
    importedCost: { input: 1.25, output: 10 },
  });

  it("persists every value the pick brought, cost included", () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      label: "GPT-5",
      modelId: "openai/gpt-5",
      credentialId: "cred_1",
      input: ["text", "image"],
      contextWindow: 400000,
      maxTokens: 128000,
      reasoning: true,
      cost: { input: 1.25, output: 10 },
    });
  });
});

describe("buildModelFormPayload — the model's name", () => {
  const CUSTOM_ENDPOINT = fields({
    apiShape: "openai-completions",
    baseUrl: "http://localhost:11434/v1",
    modelId: "qwen3:8b",
    inlineApiKey: "sk-test",
  });

  it("omits it when nothing was typed, leaving the server to derive it", () => {
    // `POST /api/models` names the row after the catalog entry, or after the
    // model id — sending "" would name it after nothing.
    const result = build({ provider: OPENAI_COMPATIBLE, fields: CUSTOM_ENDPOINT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.label).toBeUndefined();
    expect("label" in result.data).toBe(false);
  });

  it("sends it once the operator types one", () => {
    const result = build({
      provider: OPENAI_COMPATIBLE,
      fields: { ...CUSTOM_ENDPOINT, label: "  Qwen local  " },
      dirtyFields: { label: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.label).toBe("Qwen local");
  });

  it("sends the one a discovered model brought with it", () => {
    // The combobox writes every field of the pick as dirty, name included.
    const result = build({
      provider: OPENAI_COMPATIBLE,
      fields: { ...CUSTOM_ENDPOINT, label: "Qwen3 8B" },
      dirtyFields: { label: true, modelId: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.label).toBe("Qwen3 8B");
  });

  it("omits it when a name was typed then cleared again", () => {
    const result = build({
      provider: OPENAI_COMPATIBLE,
      fields: { ...CUSTOM_ENDPOINT, label: "   " },
      dirtyFields: { label: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("label" in result.data).toBe(false);
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

  it("ignores a credential the form can no longer match, creating one instead", () => {
    // Provider switched after the key was picked: the id still sits in the
    // field but names another endpoint, so it must not become the binding.
    const result = build({
      provider: OPENAI_COMPATIBLE,
      fields: fields({
        modelId: "qwen3:8b",
        baseUrl: "http://localhost:11434/v1",
        credentialId: "cred_groq",
        inlineApiKey: "sk-local",
      }),
      selectedCredentialId: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.credentialId).toBe("");
    expect(result.data.newCredential).toEqual({
      apiKey: "sk-local",
      providerId: "openai-compatible",
      baseUrlOverride: "http://localhost:11434/v1",
    });
  });

  it("refuses an unmatched credential with no inline key to fall back on", () => {
    const result = build({
      provider: OPENAI_COMPATIBLE,
      fields: fields({
        modelId: "qwen3:8b",
        baseUrl: "http://localhost:11434/v1",
        credentialId: "cred_groq",
      }),
      selectedCredentialId: null,
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

describe("toCreateModelBody", () => {
  it("drops the `null` clears, which only PATCH understands", () => {
    // A create has no stored override to drop; `POST /api/models` refuses the
    // nulls outright (`createModelSchema` — value or nothing).
    const body = toCreateModelBody(
      {
        modelId: "qwen3:8b",
        credentialId: "",
        input: null,
        contextWindow: null,
        maxTokens: null,
        reasoning: null,
      },
      "cred_new",
    );
    expect(body).toEqual({ modelId: "qwen3:8b", credentialId: "cred_new" });
  });

  it("keeps every real value, and binds the credential it was created with", () => {
    const body = toCreateModelBody(
      {
        label: "Local Qwen",
        modelId: "qwen3:8b",
        credentialId: "",
        newCredential: { apiKey: "sk-test", providerId: "openai-compatible" },
        input: ["text"],
        contextWindow: 32768,
        maxTokens: 8192,
        reasoning: false,
      },
      "cred_new",
    );
    expect(body).toEqual({
      label: "Local Qwen",
      modelId: "qwen3:8b",
      credentialId: "cred_new",
      input: ["text"],
      contextWindow: 32768,
      maxTokens: 8192,
      // Ships even as `false`: the operator answered the question.
      reasoning: false,
    });
    expect("newCredential" in body).toBe(false);
  });
});
