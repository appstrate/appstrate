// SPDX-License-Identifier: Apache-2.0

/**
 * « Choose the models » as the personal keys' list of a service draws it: the models left to each
 * member are starred like any other, so one of them can be the organization's default, and a
 * saved one opens its finer settings. The dialog around it is a Radix portal: the list is
 * rendered with the state hook it reads.
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
  personal_allowed: true,
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
  credentialId: null,
  binding: "user",
  source: "custom",
  enabled: true,
  is_default: false,
  needs_reconnection: false,
  aliased: false,
} as OrgModelInfo;

function PersonalList({ onAdvanced }: { onAdvanced?: (id: string) => void }) {
  const choice = useModelChoice({
    provider: CODEX,
    existing: [LEFT_TO_MEMBERS],
    discoverWith: null,
    tickAll: false,
    hasDefault: true,
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

describe("the personal keys' list of a subscription service", () => {
  const html = render(<PersonalList onAdvanced={() => {}} />);

  it("offers to make a model left to each member the default", () => {
    expect(html).toContain(
      `aria-label="${settingsFr["models.choice.setDefault"].replace("{{name}}", "GPT-5 Codex")}"`,
    );
  });

  it("opens a saved model's finer settings", () => {
    expect(html).toContain(settingsFr["models.choice.advanced"]);
  });
});
