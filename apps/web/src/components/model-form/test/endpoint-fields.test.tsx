// SPDX-License-Identifier: Apache-2.0

/**
 * The credential form's endpoint fields: API type and base URL where the provider lets the
 * operator describe its endpoint, then the key to type. What is asserted here is the arrangement
 * itself, and that the base URL is presented as pinned once a saved key carries it.
 */

import { describe, it, expect } from "bun:test";
import type { UseFormRegisterReturn } from "react-hook-form";
import i18n, { i18nReady } from "../../../i18n.ts";
import settingsFr from "../../../locales/fr/settings.json";
import { render } from "../../../test/render.tsx";
import { EndpointFields } from "../endpoint-fields.tsx";
import type { ProviderRegistryEntry } from "../../../hooks/use-model-provider-credentials.ts";

await i18nReady;
await i18n.changeLanguage("fr");

const fieldProps = (name: string): UseFormRegisterReturn => ({
  name,
  onChange: async () => true,
  onBlur: async () => true,
  ref: () => {},
});

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
  personal_allowed: false,
};

/** A provider that pins its own endpoint. */
const DIRECT_PROVIDER: ProviderRegistryEntry = {
  ...OPENAI_COMPATIBLE,
  providerId: "openai",
  displayName: "OpenAI",
  defaultBaseUrl: "https://api.openai.com/v1",
  baseUrlOverridable: false,
  personal_allowed: true,
};

function fields(overrides: Partial<Parameters<typeof EndpointFields>[0]> = {}): string {
  return render(
    <EndpointFields
      idPrefix="pk"
      providers={[OPENAI_COMPATIBLE]}
      provider={OPENAI_COMPATIBLE}
      onApiTypeChange={() => {}}
      baseUrlProps={fieldProps("baseUrlOverride")}
      baseUrlLocked={false}
      apiKeyProps={fieldProps("apiKey")}
      {...overrides}
    />,
  );
}

describe("EndpointFields", () => {
  it("asks for the API type, the URL and a key, under the host's id prefix", () => {
    const html = fields();
    expect(html).toContain('id="pk-apiType"');
    expect(html).toContain('id="pk-baseUrl"');
    expect(html).toContain('id="pk-apiKey"');
    expect(html).toContain(settingsFr["models.form.apiType"]);
    expect(html).toContain(settingsFr["models.form.baseUrlHint"]);
    expect(html).toContain('placeholder="sk-..."');
  });

  it("suggests the URL shape the picked API type answers on", () => {
    // A shape borrowed from another entry produces a URL that entry's API never
    // serves — `anthropic-messages` appends `/v1/models` to what is typed here.
    expect(fields()).toContain(`placeholder="${OPENAI_COMPATIBLE.defaultBaseUrl}"`);
  });

  it("pins the URL once the key carries it", () => {
    const html = fields({ baseUrlLocked: true });
    const at = html.indexOf('id="pk-baseUrl"');
    expect(html.slice(html.lastIndexOf("<input", at), html.indexOf(">", at))).toContain("disabled");
    expect(html).toContain(settingsFr["models.form.baseUrlPinnedHint"]);
  });

  it("asks only for the key where the provider pins its own endpoint", () => {
    const html = fields({ provider: DIRECT_PROVIDER, providers: [] });
    expect(html).not.toContain('id="pk-apiType"');
    expect(html).not.toContain('id="pk-baseUrl"');
    expect(html).toContain('id="pk-apiKey"');
  });

  it("renders nothing until a provider is picked", () => {
    expect(fields({ provider: undefined })).toBe("");
  });

  it("reports the errors its host resolved", () => {
    const html = fields({ baseUrlError: "URL invalide", apiKeyError: "Clé requise" });
    expect(html).toContain("URL invalide");
    expect(html).toContain("Clé requise");
  });
});
