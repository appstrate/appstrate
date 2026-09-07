// SPDX-License-Identifier: Apache-2.0

/**
 * Which fields the model form puts on screen, by provider.
 *
 * The whole point of the fix is that `openai-compatible` is a normal registry
 * provider now: picking it must surface the endpoint, the key and a free-text
 * model id, and must NOT surface an API-type selector (the credential's
 * provider pins the shape). A catalogued provider must surface none of that.
 *
 * `ModelFormBody` is rendered rather than `ModelFormModal` because the dialog
 * chrome is a Radix portal, which renders nothing at all without a DOM — and
 * the web runner has none.
 */

import { describe, it, expect } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import i18n, { i18nReady } from "../../i18n.ts";
import settingsFr from "../../locales/fr/settings.json";
import { render } from "../../test/render.tsx";
import { ModelFormBody } from "../model-form-modal.tsx";
import type { ProviderRegistryEntry } from "../../hooks/use-model-provider-credentials.ts";
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

function form(target: OrgModelInfo): string {
  const qc = new QueryClient();
  qc.setQueryData(REGISTRY_KEY, { data: [ANTHROPIC, OPENAI_COMPATIBLE] });
  qc.setQueryData(CREDENTIALS_KEY, { data: [] });
  return render(<ModelFormBody model={target} onSubmit={() => {}} />, { queryClient: qc });
}

describe("ModelFormBody — custom (OpenAI-compatible) endpoint", () => {
  const html = form(model({}));

  it("lets the operator type the endpoint and the model id", () => {
    expect(html).toContain('id="mdl-baseUrl"');
    expect(html).toContain('id="mdl-modelId"');
    expect(html).toContain(settingsFr["models.form.baseUrl"]);
  });

  it("offers the api-key block", () => {
    expect(html).toContain(settingsFr["credentials.form.apiKey"]);
    expect(html).toContain('placeholder="sk-..."');
  });

  it("orders the fields the way they are filled in", () => {
    // endpoint → key → model → name → capabilities. The credential block is
    // part of the sequence rather than gated on a model selection, which for a
    // typed endpoint never happens (nothing selects a model for it).
    const order = [
      'id="mdl-baseUrl"',
      'placeholder="sk-..."',
      'id="mdl-modelId"',
      'id="mdl-label"',
      'id="mdl-input-text"',
    ].map((marker) => html.indexOf(marker));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
  });

  it("shows the capabilities section and a label field", () => {
    expect(html).toContain(settingsFr["models.form.capabilities"]);
    expect(html).toContain('id="mdl-input-text"');
    expect(html).toContain('id="mdl-label"');
  });

  it("offers no API-type selector — the credential's provider pins the shape", () => {
    expect(html).not.toContain('id="mdl-api"');
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
    expect(html).not.toContain('id="mdl-baseUrl"');
    expect(html).not.toContain('id="mdl-modelId"');
    expect(html).not.toContain('id="mdl-api"');
  });
});
