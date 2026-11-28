// SPDX-License-Identifier: Apache-2.0

/**
 * A gateway configuration's endpoint fields: API type and base URL where the provider lets the
 * operator describe its endpoint, nothing where it pins its own.
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
};

/** A provider that pins its own endpoint. */
const DIRECT_PROVIDER: ProviderRegistryEntry = {
  ...OPENAI_COMPATIBLE,
  providerId: "openai",
  displayName: "OpenAI",
  defaultBaseUrl: "https://api.openai.com/v1",
  baseUrlOverridable: false,
};

function fields(overrides: Partial<Parameters<typeof EndpointFields>[0]> = {}): string {
  return render(
    <EndpointFields
      idPrefix="pk"
      providers={[OPENAI_COMPATIBLE]}
      provider={OPENAI_COMPATIBLE}
      onApiTypeChange={() => {}}
      baseUrlProps={fieldProps("baseUrlOverride")}
      {...overrides}
    />,
  );
}

describe("EndpointFields", () => {
  it("asks for the API type and the URL, under the host's id prefix", () => {
    const html = fields();
    expect(html).toContain('id="pk-apiType"');
    expect(html).toContain('id="pk-baseUrl"');
    expect(html).toContain(settingsFr["models.form.apiType"]);
    expect(html).toContain(settingsFr["models.form.baseUrlHint"]);
  });

  it("suggests the URL shape the picked API type answers on", () => {
    // A shape borrowed from another entry produces a URL that entry's API never
    // serves — `anthropic-messages` appends `/v1/models` to what is typed here.
    expect(fields()).toContain(`placeholder="${OPENAI_COMPATIBLE.defaultBaseUrl}"`);
  });

  it("asks nothing where the provider pins its own endpoint", () => {
    expect(fields({ provider: DIRECT_PROVIDER, providers: [] })).toBe("");
  });

  it("renders nothing until a provider is picked", () => {
    expect(fields({ provider: undefined })).toBe("");
  });

  it("reports the errors its host resolved", () => {
    expect(fields({ baseUrlError: "URL invalide" })).toContain("URL invalide");
  });
});
