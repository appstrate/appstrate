// SPDX-License-Identifier: Apache-2.0

/**
 * What the model form puts on the wire. Pinned: the omissions (a value the
 * operator never answered is left to the catalog), the `null` clears on an
 * edit, the credential binding, and that every payload names a registry
 * provider.
 */

import { describe, it, expect } from "bun:test";
import {
  buildModelFormPayload,
  buildModelsBatchPayload,
  toCreateModelBody,
  type ModelFormFields,
  type ModelFormPayloadInput,
  type ModelFormProvider,
} from "../model-form-payload.ts";
import { CUSTOM_ENDPOINT_ID } from "../provider-registry-helpers.ts";
import type { ModelPickRow } from "../model-source.ts";
import type { CatalogModelValues } from "../row-overrides-catalog.ts";

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

/** Asserts success and returns the data. */
function ok<T>(result: { ok: true; data: T } | { ok: false }): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return result.data;
}

function build(input: Partial<ModelFormPayloadInput> & { fields: ModelFormFields }) {
  return buildModelFormPayload({
    dirtyFields: {},
    provider: ANTHROPIC,
    capabilities: "auto",
    isEdit: false,
    selectedCredentialId: input.fields.credentialId || null,
    ...input,
  });
}

/** A catalogued row: the fields describe it, but none of it is the operator's. */
const CATALOGUED_FIELDS = fields({
  label: "Claude Sonnet 4.5",
  apiShape: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  modelId: "claude-sonnet-4-5-20250929",
  credentialId: "cred_1",
  contextWindow: "200000",
  maxTokens: "64000",
});

describe("buildModelFormPayload — a catalogued model, toggle off", () => {
  it("sends the binding only, leaving every catalog-derivable field to the server", () => {
    expect(ok(build({ fields: CATALOGUED_FIELDS }))).toEqual({
      modelId: "claude-sonnet-4-5-20250929",
      credentialId: "cred_1",
    });
  });

  it("clears the four on an edit, which is a no-op for a row that never overrode", () => {
    expect(ok(build({ fields: CATALOGUED_FIELDS, isEdit: true }))).toEqual({
      modelId: "claude-sonnet-4-5-20250929",
      credentialId: "cred_1",
      input: null,
      contextWindow: null,
      maxTokens: null,
      reasoning: null,
    });
  });
});

describe("buildModelFormPayload — custom endpoint", () => {
  const data = ok(
    build({
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
    }),
  );

  it("creates the credential against the registry provider, at the typed base URL", () => {
    expect(data.newCredential).toEqual({
      apiKey: "sk-test",
      providerId: "openai-compatible",
      baseUrlOverride: "http://localhost:11434/v1",
    });
    // Filled in from the create response before the model is posted.
    expect(data.credentialId).toBe("");
  });

  it("sends everything the operator typed, none of it being catalog-derivable", () => {
    expect(data).toMatchObject({
      label: "Local Qwen",
      modelId: "qwen3:8b",
      contextWindow: 32768,
      maxTokens: 8192,
      reasoning: true,
      input: ["text"],
    });
  });

  it("never puts a client-side picker sentinel on the wire", () => {
    expect(JSON.stringify(data)).not.toContain(CUSTOM_ENDPOINT_ID);
  });

  it("omits the base-URL override for a provider that pins its own endpoint", () => {
    const pinned = ok(
      build({
        provider: ANTHROPIC,
        fields: fields({
          modelId: "claude-sonnet-4-5-20250929",
          baseUrl: "https://api.anthropic.com",
          inlineApiKey: "sk-ant-test",
        }),
      }),
    );
    expect(pinned.newCredential).toEqual({ apiKey: "sk-ant-test", providerId: "anthropic" });
  });
});

describe("buildModelFormPayload — capabilities", () => {
  const CUSTOM = fields({
    modelId: "qwen3:8b",
    baseUrl: "http://localhost:11434/v1",
    inlineApiKey: "sk-test",
  });
  const FOUR = ["input", "contextWindow", "maxTokens", "reasoning"] as const;

  const explicit = (overrides: Partial<ModelFormFields> = {}, isEdit = false) =>
    ok(
      build({
        provider: OPENAI_COMPATIBLE,
        fields: { ...CUSTOM, capabilitiesExplicit: true, ...overrides },
        capabilities: "explicit",
        isEdit,
      }),
    );

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

  it("drops the modalities when neither box is ticked (the server refuses an empty array)", () => {
    expect("input" in explicit({ inputText: false, inputImage: false })).toBe(false);
  });

  it("sends only the limits actually filled in", () => {
    const data = explicit({ contextWindow: "32768", maxTokens: "  " });
    expect(data.contextWindow).toBe(32768);
    expect("maxTokens" in data).toBe(false);
  });

  it("clears a stored limit the operator blanked on an edit", () => {
    expect(explicit({ contextWindow: "", inputText: false }, true)).toMatchObject({
      contextWindow: null,
      maxTokens: null,
      input: null,
    });
  });

  it("sends none of the four when the toggle is off on a create", () => {
    const data = ok(build({ provider: OPENAI_COMPATIBLE, fields: CUSTOM, capabilities: "auto" }));
    for (const key of FOUR) expect(key in data).toBe(false);
  });

  it("clears every stored override when the toggle is off on an edit", () => {
    const data = ok(
      build({
        provider: OPENAI_COMPATIBLE,
        fields: { ...CUSTOM, contextWindow: "32768", reasoning: true },
        capabilities: "auto",
        isEdit: true,
      }),
    );
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
    credentialId: "cred_1",
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
    ok(
      build({
        fields: { ...PREFILLED, ...overrides },
        capabilities: "explicit",
        isEdit: true,
        catalogEntry,
      }),
    );

  it("ships the one modality the operator changed, and clears the three it did not", () => {
    // Sending the catalog's own numbers back would freeze them as overrides.
    expect(edit({ inputImage: false })).toEqual({
      modelId: "claude-sonnet-4-5-20250929",
      credentialId: "cred_1",
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
    const data = ok(
      build({
        provider: OPENAI_COMPATIBLE,
        fields: { ...PREFILLED, inlineApiKey: "sk-test", baseUrl: "http://localhost:11434/v1" },
        capabilities: "explicit",
        isEdit: true,
      }),
    );
    expect(data).toMatchObject({
      input: ["text", "image"],
      contextWindow: 200000,
      maxTokens: 64000,
      reasoning: true,
    });
  });

  it("omits the catalog's own values on a create, without clearing", () => {
    expect(
      ok(build({ fields: PREFILLED, capabilities: "explicit", catalogEntry: SONNET })),
    ).toEqual({ modelId: "claude-sonnet-4-5-20250929", credentialId: "cred_1" });
  });

  it("reads a catalog entry with no max output as answering nothing for it", () => {
    const data = edit({}, { ...SONNET, maxTokens: null });
    expect(data.maxTokens).toBe(64000);
    expect(data.contextWindow).toBeNull();
  });
});

describe("buildModelFormPayload — the model's name", () => {
  const CUSTOM_ENDPOINT = fields({
    apiShape: "openai-completions",
    baseUrl: "http://localhost:11434/v1",
    modelId: "qwen3:8b",
    inlineApiKey: "sk-test",
  });
  const named = (label: string, dirty: boolean) =>
    ok(
      build({
        provider: OPENAI_COMPATIBLE,
        fields: { ...CUSTOM_ENDPOINT, label },
        dirtyFields: dirty ? { label: true } : {},
      }),
    );

  it("omits it when nothing was typed, leaving the server to derive it", () => {
    expect("label" in named("", false)).toBe(false);
  });

  it("sends it, trimmed, once the operator types one", () => {
    expect(named("  Qwen local  ", true).label).toBe("Qwen local");
  });

  it("omits it when a name was typed then cleared again", () => {
    expect("label" in named("   ", true)).toBe(false);
  });
});

describe("buildModelFormPayload — missing credential", () => {
  it.each([
    [
      "an OAuth provider with no connection selected",
      CLAUDE_CODE,
      "models.form.connectionRequired",
    ],
    [
      "an api-key provider with neither a selection nor an inline key",
      ANTHROPIC,
      "models.form.apiKeyRequired",
    ],
  ])("refuses %s", (_name, provider, messageKey) => {
    expect(build({ provider, fields: fields({ modelId: "claude-sonnet-4-5-20250929" }) })).toEqual({
      ok: false,
      field: "credentialId",
      messageKey,
    });
  });

  it("ignores a credential the form cannot match (provider switched after the pick), creating one instead", () => {
    const data = ok(
      build({
        provider: OPENAI_COMPATIBLE,
        fields: fields({
          modelId: "qwen3:8b",
          baseUrl: "http://localhost:11434/v1",
          credentialId: "cred_groq",
          inlineApiKey: "sk-local",
        }),
        selectedCredentialId: null,
      }),
    );
    expect(data.credentialId).toBe("");
    expect(data.newCredential).toEqual({
      apiKey: "sk-local",
      providerId: "openai-compatible",
      baseUrlOverride: "http://localhost:11434/v1",
    });
  });

  it("refuses an unmatched credential with no inline key to fall back on", () => {
    expect(
      build({
        provider: OPENAI_COMPATIBLE,
        fields: fields({
          modelId: "qwen3:8b",
          baseUrl: "http://localhost:11434/v1",
          credentialId: "cred_groq",
        }),
        selectedCredentialId: null,
      }),
    ).toEqual({ ok: false, field: "credentialId", messageKey: "models.form.apiKeyRequired" });
  });

  it("refuses an inline key typed before any provider is picked", () => {
    expect(
      build({
        provider: undefined,
        fields: fields({ modelId: "qwen3:8b", inlineApiKey: "sk-test" }),
      }).ok,
    ).toBe(false);
  });
});

describe("toCreateModelBody", () => {
  it("drops the `null` clears, which only PUT understands", () => {
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
      reasoning: false,
    });
    expect("newCredential" in body).toBe(false);
  });
});

// --- buildModelsBatchPayload ---

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

const DESCRIBED: Partial<ModelPickRow> = {
  label: "Described",
  contextWindow: 32768,
  maxTokens: 8192,
  input: ["text", "image"],
  reasoning: true,
  cost: { input: 1.25, output: 10 },
};

describe("buildModelsBatchPayload — what a row ships, per origin", () => {
  it.each([
    [
      "catalog: the id only, so the catalog keeps answering",
      row({ id: "m", origin: "catalog", ...DESCRIBED, source: "catalog", featured: true }),
      { modelId: "m" },
    ],
    [
      "discover: what the listing described, never the cost",
      row({ id: "m", origin: "discover", ...DESCRIBED, source: "endpoint" }),
      {
        label: "Described",
        modelId: "m",
        input: ["text", "image"],
        contextWindow: 32768,
        maxTokens: 8192,
        reasoning: true,
      },
    ],
    [
      "discover: nothing but the id for a model nobody described",
      row({ id: "m", origin: "discover" }),
      { modelId: "m" },
    ],
    [
      "discover: a reported false is kept, an empty modality list is dropped",
      row({ id: "m", origin: "discover", input: [], reasoning: false }),
      { modelId: "m", reasoning: false },
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
    expect(ok(buildModelsBatchPayload({ ...SAVED_KEY, rows: [picked] })).models).toEqual([entry]);
  });
});

describe("buildModelsBatchPayload — the credential they all share", () => {
  const ROWS = [row({ id: "a", origin: "discover" }), row({ id: "b", origin: "discover" })];

  it("binds every entry to the saved key that was picked", () => {
    const data = ok(buildModelsBatchPayload({ ...SAVED_KEY, rows: ROWS }));
    expect(data.credentialId).toBe("cred_1");
    expect(data.newCredential).toBeUndefined();
    expect(data.models).toHaveLength(2);
  });

  it("creates the typed key ONCE, for the whole batch", () => {
    const data = ok(
      buildModelsBatchPayload({
        ...SAVED_KEY,
        selectedCredentialId: null,
        inlineApiKey: "sk-test",
        rows: ROWS,
      }),
    );
    expect(data.credentialId).toBe("");
    expect(data.newCredential).toEqual({
      apiKey: "sk-test",
      providerId: "openai-compatible",
      baseUrlOverride: "http://localhost:11434/v1",
    });
  });

  it("omits the base-URL override for a provider that pins its own endpoint", () => {
    const data = ok(
      buildModelsBatchPayload({
        ...SAVED_KEY,
        provider: ANTHROPIC,
        selectedCredentialId: null,
        inlineApiKey: "sk-ant-test",
        rows: ROWS,
      }),
    );
    expect(data.newCredential).toEqual({ apiKey: "sk-ant-test", providerId: "anthropic" });
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
