// SPDX-License-Identifier: Apache-2.0

/**
 * The one arrangement the model form uses for every provider: pick the
 * provider, describe the endpoint, then name the model.
 *
 * Only two registry facts move anything. `baseUrlOverridable` decides whether
 * the API type and the base URL are the operator's to answer; `authMode`
 * decides whether the endpoint is opened with a key or a connection. So what is
 * asserted here is the same three steps under four different providers, and the
 * one question a static render CAN answer about the third step: on an edit, has
 * this row overridden its catalog or not.
 *
 * `ModelFormBody` is rendered rather than `ModelFormModal` because the dialog
 * chrome is a Radix portal, which renders nothing at all without a DOM — and
 * the web runner has none. Select ITEMS are portalled too, so what a picker
 * offers is asserted on `buildProviderPickerRows` instead (see
 * `lib/test/provider-registry-helpers.test.ts`), and the pick list — which only
 * exists after a listing answers — on the component itself (see
 * `model-form/test/model-pick-list.test.tsx`).
 */

import { describe, it, expect } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import i18n, { i18nReady } from "../../i18n.ts";
import settingsFr from "../../locales/fr/settings.json";
import { render } from "../../test/render.tsx";
import { ModelFormBody } from "../model-form-modal.tsx";
import type {
  ModelProviderCredentialInfo,
  ProviderRegistryEntry,
} from "../../hooks/use-model-provider-credentials.ts";
import type { OrgModelInfo } from "../../hooks/use-models.ts";

await i18nReady;
await i18n.changeLanguage("fr");

/**
 * openapi-react-query keys are `[method, path, init]`, and both hooks pass the
 * org header explicitly (`useOrgOnlyScope`). No org is selected in the runner,
 * so the header value is `undefined` — mirrored here so the seeded entry is the
 * one the hook reads.
 */
const ORG_SCOPE = { params: { header: { "X-Org-Id": undefined } } };
const REGISTRY_KEY = ["get", "/api/model-provider-credentials/registry", ORG_SCOPE];
const CREDENTIALS_KEY = ["get", "/api/model-provider-credentials", ORG_SCOPE];

const OPENAI_COMPATIBLE: ProviderRegistryEntry = {
  providerId: "openai-compatible",
  displayName: "OpenAI-compatible (custom)",
  iconUrl: "openai",
  description: null,
  docsUrl: null,
  apiShape: "openai-completions",
  defaultBaseUrl: "http://localhost:11434",
  baseUrlOverridable: true,
  authMode: "api_key",
  featured: false,
  models: [],
};

/** The catalog entry every "does this row override it?" case is measured against. */
const SONNET = {
  id: "claude-sonnet-4-5-20250929",
  label: "Claude Sonnet 4.5",
  featured: true,
  contextWindow: 200000,
  maxTokens: 64000,
  capabilities: ["text", "image", "reasoning"],
  cost: { input: 3, output: 15 },
};

const ANTHROPIC: ProviderRegistryEntry = {
  providerId: "anthropic",
  displayName: "Anthropic",
  iconUrl: "anthropic",
  description: null,
  docsUrl: null,
  apiShape: "anthropic-messages",
  defaultBaseUrl: "https://api.anthropic.com",
  baseUrlOverridable: false,
  authMode: "api_key",
  featured: true,
  models: [SONNET],
};

/** A subscription provider: same catalog, opened by a connection, not a key. */
const CLAUDE_CODE: ProviderRegistryEntry = {
  ...ANTHROPIC,
  providerId: "claude-code",
  displayName: "Claude Code",
  authMode: "oauth2",
};

function model(overrides: Partial<OrgModelInfo>): OrgModelInfo {
  return {
    id: "mdl_1",
    label: "Local Qwen",
    apiShape: "openai-completions",
    providerId: "openai-compatible",
    providerName: "OpenAI-compatible (custom)",
    baseUrl: "http://localhost:11434/v1",
    modelId: "qwen3:8b",
    generation: null,
    enabled: true,
    is_default: false,
    needs_reconnection: false,
    aliased: false,
    iconUrl: null,
    source: "custom",
    credentialId: "cred_1",
    created_by: null,
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:00:00.000Z",
    ...overrides,
  };
}

/** A catalogued row as `GET /api/models` returns it: RESOLVED from the catalog. */
function catalogued(overrides: Partial<OrgModelInfo> = {}): OrgModelInfo {
  return model({
    label: "Claude Sonnet 4.5",
    apiShape: "anthropic-messages",
    providerId: "anthropic",
    providerName: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    modelId: SONNET.id,
    credentialId: "cred_ant",
    input: ["text", "image"],
    contextWindow: SONNET.contextWindow,
    maxTokens: SONNET.maxTokens,
    reasoning: true,
    ...overrides,
  });
}

/** The key the edited row is bound to. Every custom credential names the
 *  provider it was created for, which is what an overridable one is matched on. */
const LOCAL_KEY: ModelProviderCredentialInfo = {
  id: "cred_1",
  label: "localhost:11434 · OpenAI-compatible",
  apiShape: "openai-completions",
  baseUrl: "http://localhost:11434/v1",
  providerId: "openai-compatible",
  source: "custom",
  authMode: "api_key",
  created_by: null,
  createdAt: "2026-07-01T10:00:00.000Z",
  updatedAt: "2026-07-01T10:00:00.000Z",
};

/** The same provider, saved against another host — E1's whole point. */
const REMOTE_KEY: ModelProviderCredentialInfo = {
  ...LOCAL_KEY,
  id: "cred_2",
  label: "vllm.internal · OpenAI-compatible",
  baseUrl: "https://vllm.internal/v1",
};

/** A pinned provider matches its keys on the endpoint, not on the provider id. */
const ANTHROPIC_KEY: ModelProviderCredentialInfo = {
  ...LOCAL_KEY,
  id: "cred_ant",
  label: "Anthropic",
  apiShape: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  providerId: "anthropic",
};

const CONNECTION: ModelProviderCredentialInfo = {
  ...ANTHROPIC_KEY,
  id: "cred_cc",
  label: "Claude Code",
  providerId: "claude-code",
  authMode: "oauth2",
  oauth_email: "dev@example.com",
};

function form(
  target: OrgModelInfo | null,
  credentials: ModelProviderCredentialInfo[] = [],
): string {
  const qc = new QueryClient();
  qc.setQueryData(REGISTRY_KEY, { data: [ANTHROPIC, CLAUDE_CODE, OPENAI_COMPATIBLE] });
  qc.setQueryData(CREDENTIALS_KEY, { data: credentials });
  return render(<ModelFormBody model={target} onSubmit={() => {}} />, { queryClient: qc });
}

describe("ModelFormBody — adding a model, nothing picked yet", () => {
  const html = form(null);

  it("asks for the provider, and for nothing an unpicked provider cannot answer", () => {
    expect(html).toContain('id="mdl-provider"');
    expect(html).not.toContain('id="mdl-apiType"');
    expect(html).not.toContain('id="mdl-baseUrl"');
    expect(html).not.toContain('placeholder="sk-..."');
    expect(html).not.toContain('id="mdl-modelId"');
  });

  it("keeps the model id registered, so saving too early is answered", () => {
    // Without the field on screen nothing validates the id, and the save button
    // reports nothing at all.
    expect(html).toContain('type="hidden"');
    expect(html).toContain('name="modelId"');
  });
});

describe("ModelFormBody — editing a custom endpoint", () => {
  // A saved row carries a capability no catalog claims, so the toggle opens on.
  const html = form(model({ contextWindow: 32768 }), [LOCAL_KEY]);

  it("describes the endpoint: which API it speaks, where it is, which key opens it", () => {
    expect(html).toContain('id="mdl-apiType"');
    expect(html).toContain(settingsFr["models.form.apiType"]);
    expect(html).toContain('id="mdl-baseUrl"');
    expect(html).toContain(settingsFr["credentials.form.apiKey"]);
    expect(html).toContain(LOCAL_KEY.label);
  });

  it("locks the base URL, which belongs to the selected key", () => {
    // Editing it here would save a 200 that changes nothing: the URL rides on
    // the credential (`baseUrlOverride`), not on the model row.
    const input = html.slice(html.indexOf('id="mdl-baseUrl"'));
    expect(input.slice(0, input.indexOf(">"))).toContain("disabled");
    expect(html).toContain(settingsFr["models.form.baseUrlPinnedHint"]);
  });

  it("opens on the model the row already names, editable and free-text", () => {
    expect(html).toContain('id="mdl-modelId"');
    expect(html).toContain('id="mdl-label"');
    // The name is required on a saved row: PUT reads an absent one as "keep",
    // so promising a derived one would describe a save that changes nothing.
    expect(html).not.toContain(settingsFr["models.form.labelPlaceholder"]);
  });

  it("opens the capabilities on the row's own values, the toggle already on", () => {
    // No catalog entry claims `qwen3:8b`, so the 32768 can only be an answer
    // the operator gave.
    expect(checkedState(html, "mdl-capabilities-explicit")).toBe("true");
    for (const id of [
      "mdl-ctx",
      "mdl-maxtok",
      "mdl-input-text",
      "mdl-input-image",
      "mdl-reasoning",
    ])
      expect(html).toContain(`id="${id}"`);
    expect(html).not.toContain(settingsFr["models.form.capabilitiesAuto"]);
  });

  it("offers no listing: that adds rows, and an edit changes this one", () => {
    expect(html).not.toContain(settingsFr["models.form.discoverButton"]);
    expect(html).not.toContain(settingsFr["models.form.manualButton"]);
    expect(html).not.toContain(settingsFr["models.form.pickFromList"]);
    expect(html).not.toContain('id="mdl-pick-all"');
  });

  it("orders the fields the way they are filled in", () => {
    // provider → endpoint (type → URL → key) → the model → its name → capabilities.
    const order = [
      'id="mdl-provider"',
      'id="mdl-apiType"',
      'id="mdl-baseUrl"',
      settingsFr["credentials.form.apiKey"],
      'id="mdl-modelId"',
      'id="mdl-label"',
      'id="mdl-capabilities-explicit"',
    ].map((marker) => html.indexOf(marker));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("ModelFormBody — custom endpoint with no key to open it", () => {
  // Same row, but the key it names is not in the list: step 1 is unanswered.
  const html = form(model({}));

  it("asks for a key before asking which model to run", () => {
    expect(html).toContain('id="mdl-baseUrl"');
    expect(html).toContain('placeholder="sk-..."');
    expect(html).not.toContain(settingsFr["models.form.discoverButton"]);
    expect(html).not.toContain('id="mdl-modelId"');
    expect(html).not.toContain('id="mdl-label"');
  });

  it("keeps the model id registered, so saving too early is answered", () => {
    expect(html).toContain('type="hidden"');
    expect(html).toContain('name="modelId"');
  });

  it("suggests the URL shape the picked API type answers on", () => {
    expect(html).toContain(`placeholder="${OPENAI_COMPATIBLE.defaultBaseUrl}"`);
  });
});

describe("ModelFormBody — custom endpoint, keys saved against other hosts", () => {
  // Nothing is bound (the row names a key that no longer exists), and the only
  // saved key answers on a different URL than the one the form holds.
  const html = form(model({ credentialId: "cred_gone" }), [REMOTE_KEY]);

  it("still offers the saved keys, since the picked one brings its own URL", () => {
    // Select ITEMS are portalled, so what the picker holds is asserted in
    // `lib/test/model-credential-filter.test.ts`; here the trigger's presence
    // is the observable — provider, API type, and the "my keys" picker.
    expect(html.split('role="combobox"').length - 1).toBe(3);
    expect(html).toContain('id="mdl-apiKey"');
  });
});

describe("ModelFormBody — editing a catalogued row that overrides nothing", () => {
  const html = form(catalogued(), [ANTHROPIC_KEY]);

  it("shows no endpoint questions: a pinned provider's endpoint is not the operator's", () => {
    expect(html).not.toContain('id="mdl-apiType"');
    expect(html).not.toContain('id="mdl-baseUrl"');
  });

  it("shows the bound key as a chip, and the model as a plain editable id", () => {
    expect(html).toContain(ANTHROPIC_KEY.label);
    expect(html).not.toContain('placeholder="sk-..."');
    expect(html).toContain('id="mdl-modelId"');
    expect(html).toContain('id="mdl-label"');
  });

  it("leaves the capabilities toggle off, because the row equals its catalog entry", () => {
    // `GET /api/models` resolves these from the catalog, so reading "carries a
    // number" as "overrides" would freeze the catalog's own values on the next
    // save and stop the weekly refresh reaching the row.
    expect(checkedState(html, "mdl-capabilities-explicit")).toBe("false");
    expect(html).toContain(settingsFr["models.form.capabilitiesAuto"]);
    expect(html).not.toContain('id="mdl-ctx"');
  });
});

describe("ModelFormBody — editing a catalogued row that does override it", () => {
  const html = form(catalogued({ contextWindow: 32768 }), [ANTHROPIC_KEY]);

  it("opens the toggle on, because the row disagrees with the catalog", () => {
    expect(checkedState(html, "mdl-capabilities-explicit")).toBe("true");
    expect(html).toContain('id="mdl-ctx"');
    expect(html).not.toContain(settingsFr["models.form.capabilitiesAuto"]);
  });
});

describe("ModelFormBody — editing a subscription row", () => {
  const html = form(
    catalogued({ providerId: "claude-code", providerName: "Claude Code", credentialId: "cred_cc" }),
    [CONNECTION],
  );

  it("shows the connection it runs on, and the account behind it", () => {
    expect(html).toContain(settingsFr["models.form.connectionLabel"]);
    expect(html).toContain(CONNECTION.label);
    expect(html).toContain(CONNECTION.oauth_email!);
  });

  it("asks for no key: a subscription is opened by a connection, not a secret", () => {
    expect(html).not.toContain('placeholder="sk-..."');
    expect(html).not.toContain('id="mdl-apiKey"');
    expect(html).not.toContain(settingsFr["models.form.connectProviderHint"]);
  });

  it("offers neither listing nor a way back to one", () => {
    expect(html).not.toContain(settingsFr["models.form.discoverButton"]);
    expect(html).not.toContain(settingsFr["models.form.manualButton"]);
    expect(html).not.toContain(settingsFr["models.form.pickFromList"]);
  });
});

/** A Radix checkbox is a `button`, so its state reads off `aria-checked`. */
function checkedState(html: string, id: string): string | undefined {
  const tag = html.slice(html.lastIndexOf("<button", html.indexOf(`id="${id}"`)));
  return /aria-checked="(\w+)"/.exec(tag.slice(0, tag.indexOf(">")))?.[1];
}
