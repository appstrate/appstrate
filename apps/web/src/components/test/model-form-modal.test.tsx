// SPDX-License-Identifier: Apache-2.0

/**
 * The edit form of a saved model: its id, its name and its capabilities. The model stays in its
 * configuration, whose connections serve it: the form asks for no key. The catalog decides
 * whether the capabilities toggle opens on, i.e. whether this row has overridden its catalog
 * entry.
 *
 * `ModelFormBody` is rendered rather than `ModelFormModal` because the dialog chrome is a
 * portal, which renders nothing at all without a DOM — and the web runner has none. The payload
 * is asserted on `lib/test/model-form-payload.test.ts`.
 */

import { describe, it, expect } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import i18n, { i18nReady } from "../../i18n.ts";
import settingsFr from "../../locales/fr/settings.json";
import { render } from "../../test/render.tsx";
import { ModelFormBody } from "../model-form-modal.tsx";
import type { ProviderRegistryEntry } from "../../hooks/use-model-provider-credentials.ts";
import type { OrgModelInfo } from "../../hooks/use-models.ts";
import { UNKNOWN_MODEL_GENERATION_CAPABILITIES } from "@appstrate/core/model-generation";

await i18nReady;
await i18n.changeLanguage("fr");

/**
 * openapi-react-query keys are `[method, path, init]`, and the hook passes the
 * org header explicitly (`useOrgOnlyScope`). No org is selected in the runner,
 * so the header value is `undefined` — mirrored here so the seeded entry is the
 * one the hook reads.
 */
const ORG_SCOPE = { params: { header: { "X-Org-Id": undefined } } };
const REGISTRY_KEY = ["get", "/api/model-provider-credentials/registry", ORG_SCOPE];

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
  live_model_search: false,
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
  generation: UNKNOWN_MODEL_GENERATION_CAPABILITIES,
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
  live_model_search: false,
  models: [SONNET],
};

function model(overrides: Partial<OrgModelInfo>): OrgModelInfo {
  return {
    id: "mdl_1",
    label: "Local Qwen",
    apiShape: "openai-completions",
    providerId: "openai-compatible",
    provider_name: "OpenAI-compatible (custom)",
    pi_provider: null,
    pi_dialect: null,
    base_url: "http://localhost:11434/v1",
    modelId: "qwen3:8b",
    generation: null,
    enabled: true,
    is_default: false,
    needs_reconnection: false,
    aliased: false,
    iconUrl: null,
    source: "custom",
    config_id: "cfg_1",
    billed_to: "org",
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
    provider_name: "Anthropic",
    pi_provider: "anthropic",
    pi_dialect: null,
    base_url: "https://api.anthropic.com",
    modelId: SONNET.id,
    input: ["text", "image"],
    contextWindow: SONNET.contextWindow,
    maxTokens: SONNET.maxTokens,
    reasoning: true,
    ...overrides,
  });
}

function form(target: OrgModelInfo): string {
  const qc = new QueryClient();
  qc.setQueryData(REGISTRY_KEY, { data: [ANTHROPIC, OPENAI_COMPATIBLE] });
  return render(<ModelFormBody model={target} onSubmit={async () => {}} />, { queryClient: qc });
}

describe("ModelFormBody — editing a custom endpoint", () => {
  // A saved row carries a capability no catalog claims, so the toggle opens on.
  const html = form(model({ contextWindow: 32768 }));

  it("asks for no key and no endpoint: the configuration holds them", () => {
    for (const absent of [
      'id="mdl-credential"',
      'id="mdl-provider"',
      'id="mdl-apiType"',
      'id="mdl-baseUrl"',
    ])
      expect(html).not.toContain(absent);
    expect(html).not.toContain('placeholder="sk-..."');
  });

  it("opens on the model the row already names, editable and free-text", () => {
    expect(html).toContain('id="mdl-modelId"');
    expect(html).toContain('id="mdl-label"');
    // The name is required on a saved row: PATCH reads an absent one as "keep",
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
    expect(html).not.toContain('id="mdl-pick-all"');
  });

  it("orders the fields the way they are filled in", () => {
    // the model → its name → capabilities.
    const order = ['id="mdl-modelId"', 'id="mdl-label"', 'id="mdl-capabilities-explicit"'].map(
      (marker) => html.indexOf(marker),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("ModelFormBody — editing a catalogued row that overrides nothing", () => {
  const html = form(catalogued());

  it("shows the model as a plain editable id, with no key to type", () => {
    expect(html).toContain('id="mdl-modelId"');
    expect(html).toContain('id="mdl-label"');
    expect(html).not.toContain('placeholder="sk-..."');
  });

  it("leaves the capabilities toggle off, because the row equals its catalog entry", () => {
    // `GET /api/models` resolves these from the catalog, so reading "carries a
    // number" as "overrides" would freeze the catalog's own values on the next
    // save and stop a catalog update (a Pi bump) reaching the row.
    expect(checkedState(html, "mdl-capabilities-explicit")).toBe("false");
    expect(html).toContain(settingsFr["models.form.capabilitiesAuto"]);
    expect(html).not.toContain('id="mdl-ctx"');
  });
});

describe("ModelFormBody — editing a catalogued row that does override it", () => {
  const html = form(catalogued({ contextWindow: 32768 }));

  it("opens the toggle on, because the row disagrees with the catalog", () => {
    expect(checkedState(html, "mdl-capabilities-explicit")).toBe("true");
    expect(html).toContain('id="mdl-ctx"');
    expect(html).not.toContain(settingsFr["models.form.capabilitiesAuto"]);
  });
});

describe("ModelFormBody — editing a row whose provider left the registry", () => {
  const html = form(model({ providerId: "gone", provider_name: "Gone" }));

  it("says so, instead of an empty form whose Save reports nothing", () => {
    expect(html).toContain(settingsFr["models.form.providerUnavailable"]);
    expect(html).not.toContain('id="mdl-modelId"');
    expect(html).not.toContain('id="mdl-capabilities-explicit"');
  });
});

/** A checkbox is a `button`, so its state reads off `aria-checked`. */
function checkedState(html: string, id: string): string | undefined {
  const tag = html.slice(html.lastIndexOf("<button", html.indexOf(`id="${id}"`)));
  return /aria-checked="(\w+)"/.exec(tag.slice(0, tag.indexOf(">")))?.[1];
}
