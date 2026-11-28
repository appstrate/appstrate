// SPDX-License-Identifier: Apache-2.0

/**
 * « Choose the models » of a configuration: a saved model opens its finer settings, and the
 * default model keeps its access (its box cannot be unticked). The dialog around it is a portal:
 * the list is rendered with the state hook it reads.
 */

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import settingsFr from "../../locales/fr/settings.json";
import { render } from "../../test/render.tsx";
import { ModelChoiceList } from "../model-choice.tsx";
import { useModelChoice } from "../../hooks/use-model-choice.ts";
import type { ProviderRegistryEntry } from "../../hooks/use-model-provider-credentials.ts";
import type { OrgModelInfo } from "../../hooks/use-models.ts";

await i18nReady;
await i18n.changeLanguage("fr");

const CODEX = {
  providerId: "codex",
  displayName: "Codex",
  iconUrl: "openai",
  apiShape: "openai-codex-responses",
  defaultBaseUrl: "https://chatgpt.com/backend-api",
  baseUrlOverridable: false,
  authMode: "oauth2",
  featured: false,
  live_model_search: false,
  models: [
    {
      id: "gpt-5-codex",
      label: "GPT-5 Codex",
      featured: true,
      capabilities: ["text", "reasoning"],
      contextWindow: 400000,
      maxTokens: 128000,
    },
  ],
} as unknown as ProviderRegistryEntry;

const LEFT_TO_MEMBERS = {
  id: "mdl_member",
  label: "GPT-5 Codex",
  providerId: "codex",
  modelId: "gpt-5-codex",
  config_id: "cfg_codex",
  billed_to: "user",
  source: "custom",
  enabled: true,
  is_default: true,
  needs_reconnection: false,
  aliased: false,
} as OrgModelInfo;

function ConfigList({ onAdvanced }: { onAdvanced?: (id: string) => void }) {
  const choice = useModelChoice({
    provider: CODEX,
    existing: [LEFT_TO_MEMBERS],
    discoverWith: null,
    tickNew: false,
  });
  return (
    <ModelChoiceList
      choice={choice}
      advanced={
        onAdvanced ? { ids: new Set([LEFT_TO_MEMBERS.modelId!]), onOpen: onAdvanced } : undefined
      }
    />
  );
}

describe("the models of a configuration", () => {
  const html = render(<ConfigList onAdvanced={() => {}} />);

  it("keeps the default model's box ticked, and says why", () => {
    expect(html).toContain(`title="${settingsFr["models.choice.defaultLocked"]}"`);
  });

  it("offers no star: the default is chosen at the top of the page", () => {
    expect(html).not.toContain("aria-pressed");
  });

  it("opens a saved model's finer settings", () => {
    expect(html).toContain(settingsFr["models.choice.advanced"]);
  });
});
