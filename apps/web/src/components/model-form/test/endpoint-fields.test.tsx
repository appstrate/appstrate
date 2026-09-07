// SPDX-License-Identifier: Apache-2.0

/**
 * The endpoint fields both forms share.
 *
 * The model form and the credential form describe the same thing — an endpoint
 * the operator supplies — so they render one component, under their own id
 * prefix. What is asserted here is what neither host can assert for the other:
 * that the arrangement is the same one, and that the base URL is presented as
 * belonging to the key whenever a key already carries it.
 */

import { describe, it, expect } from "bun:test";
import type { UseFormRegisterReturn } from "react-hook-form";
import i18n, { i18nReady } from "../../../i18n.ts";
import settingsFr from "../../../locales/fr/settings.json";
import { render } from "../../../test/render.tsx";
import { EndpointFields } from "../endpoint-fields.tsx";
import type {
  ModelProviderCredentialInfo,
  ProviderRegistryEntry,
} from "../../../hooks/use-model-provider-credentials.ts";

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
  models: [],
};

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

function fields(overrides: Partial<Parameters<typeof EndpointFields>[0]> = {}): string {
  return render(
    <EndpointFields
      idPrefix="pk"
      providers={[OPENAI_COMPATIBLE]}
      providerId={OPENAI_COMPATIBLE.providerId}
      onProviderChange={() => {}}
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

  it("renames its fields for the other host", () => {
    const html = fields({ idPrefix: "mdl" });
    expect(html).toContain('id="mdl-apiType"');
    expect(html).toContain('id="mdl-baseUrl"');
    expect(html).toContain('id="mdl-apiKey"');
  });

  it("pins the URL to the key that carries it, and offers to unpick that key", () => {
    const html = fields({
      idPrefix: "mdl",
      baseUrlLocked: true,
      existingKeys: {
        items: [LOCAL_KEY],
        selected: LOCAL_KEY,
        onSelect: () => {},
        onClear: () => {},
      },
    });
    const input = html.slice(html.indexOf('id="mdl-baseUrl"'));
    expect(input.slice(0, input.indexOf(">"))).toContain("disabled");
    expect(html).toContain(settingsFr["models.form.baseUrlPinnedHint"]);
    expect(html).toContain(LOCAL_KEY.label);
    // The key is selected, so there is nothing to type into.
    expect(html).not.toContain('placeholder="sk-..."');
  });

  it("reports the errors its host resolved", () => {
    const html = fields({ baseUrlError: "URL invalide", apiKeyError: "Clé requise" });
    expect(html).toContain("URL invalide");
    expect(html).toContain("Clé requise");
  });
});
