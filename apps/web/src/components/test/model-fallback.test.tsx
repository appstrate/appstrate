// SPDX-License-Identifier: Apache-2.0

/**
 * A run on another model than the one chosen is told after it, as a warning
 * card on the run's overview (the `model_fallback` marker of its journal).
 */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { ModelFallbackCard } = await import("../run-detail/run-warnings.tsx");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const AGENT_PATH = "/agents/@acme/worker";

describe("the run's « Modèle remplacé » card", () => {
  it("names the model chosen, the model that served, and where to change it", () => {
    const html = render(
      <ModelFallbackCard
        chosen="Mistral local"
        used="Claude Sonnet 5"
        settingsTo={{ pathname: AGENT_PATH, search: "?agentSettings=model", hash: "#settings" }}
      />,
    );
    expect(html).toContain("Modèle remplacé");
    expect(html).toContain("Modèle choisi : Mistral local");
    expect(html).toContain("Modèle utilisé : Claude Sonnet 5");
    expect(html).toContain(`href="${AGENT_PATH}?agentSettings=model#settings"`);
  });

  it("offers no link to a reader who cannot reach the agent's settings", () => {
    const html = render(
      <ModelFallbackCard chosen="mdl_gone" used="Claude Sonnet 5" settingsTo={null} />,
    );
    expect(html).toContain("Modèle choisi : mdl_gone");
    expect(html).not.toContain("<a ");
  });
});
