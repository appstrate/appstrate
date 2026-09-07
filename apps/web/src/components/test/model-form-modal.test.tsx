// SPDX-License-Identifier: Apache-2.0

/**
 * Which fields the model form puts on screen, by provider.
 *
 * An endpoint the operator supplies is described in two steps: what it is and
 * how to open it (API type, base URL, key), then which model to run on it —
 * and the second step only exists once the first one is answered. A catalogued
 * provider must surface none of that: its endpoint is not the operator's.
 *
 * `ModelFormBody` is rendered rather than `ModelFormModal` because the dialog
 * chrome is a Radix portal, which renders nothing at all without a DOM — and
 * the web runner has none. Select ITEMS are portalled too, so what a picker
 * offers is asserted on `buildProviderPickerRows` instead (see
 * `lib/test/provider-registry-helpers.test.ts`).
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
  models: [
    {
      id: "claude-sonnet-4-5-20250929",
      label: "Claude Sonnet 4.5",
      featured: true,
      contextWindow: 200000,
      maxTokens: 64000,
      capabilities: ["text", "image", "reasoning"],
      cost: { input: 3, output: 15 },
    },
  ],
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

/** The key the edited model is bound to — matched on apiShape + base URL. */
const LOCAL_KEY: ModelProviderCredentialInfo = {
  id: "cred_1",
  label: "Ollama local",
  apiShape: "openai-completions",
  baseUrl: "http://localhost:11434/v1",
  source: "custom",
  authMode: "api_key",
  created_by: null,
  createdAt: "2026-07-01T10:00:00.000Z",
  updatedAt: "2026-07-01T10:00:00.000Z",
};

function form(target: OrgModelInfo, credentials: ModelProviderCredentialInfo[] = []): string {
  const qc = new QueryClient();
  qc.setQueryData(REGISTRY_KEY, { data: [ANTHROPIC, OPENAI_COMPATIBLE] });
  qc.setQueryData(CREDENTIALS_KEY, { data: credentials });
  return render(<ModelFormBody model={target} onSubmit={() => {}} />, { queryClient: qc });
}

describe("ModelFormBody — editing a custom endpoint", () => {
  // A saved row carries a capability, so the "Avancé" fold opens on it.
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
    expect(html).toContain(settingsFr["models.form.advanced"]);
    // "Avancé" is open, so the capabilities the row carries are on screen.
    expect(html).toContain(settingsFr["models.form.capabilities"]);
    expect(html).toContain('id="mdl-input-text"');
  });

  it("still offers to ask the endpoint what it serves", () => {
    expect(html).toContain(settingsFr["models.form.discoverButton"]);
    expect(html).toContain(settingsFr["models.form.manualButton"]);
  });

  it("orders the fields the way they are filled in", () => {
    // endpoint (type → URL → key) → the two ways to name a model → the model
    // → its name → the capabilities fold.
    const order = [
      'id="mdl-apiType"',
      'id="mdl-baseUrl"',
      settingsFr["credentials.form.apiKey"],
      settingsFr["models.form.discoverButton"],
      'id="mdl-modelId"',
      'id="mdl-label"',
      settingsFr["models.form.advanced"],
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
});

describe("ModelFormBody — catalogued provider", () => {
  const html = form(
    model({
      label: "Claude Sonnet 4.5",
      apiShape: "anthropic-messages",
      providerId: "anthropic",
      providerName: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      modelId: "claude-sonnet-4-5-20250929",
    }),
  );

  it("picks the model from the catalog instead of exposing the binding", () => {
    expect(html).toContain('id="mdl-model"');
    expect(html).not.toContain('id="mdl-apiType"');
    expect(html).not.toContain('id="mdl-baseUrl"');
    expect(html).not.toContain('id="mdl-modelId"');
  });

  it("offers no endpoint discovery — the catalog already lists the models", () => {
    expect(html).not.toContain(settingsFr["models.form.discoverButton"]);
    expect(html).not.toContain(settingsFr["models.form.manualButton"]);
  });
});
