// SPDX-License-Identifier: Apache-2.0

/**
 * What a listing REPORTS about itself, once one has been asked for.
 *
 * The count is not the endpoint's answer when a cap stopped the read, and the
 * difference between "these are the models" and "these are the first models"
 * is the operator's to act on — they have to name the missing one by hand.
 */

import { describe, it, expect } from "bun:test";
import i18n, { i18nReady } from "../../../i18n.ts";
import settingsFr from "../../../locales/fr/settings.json";
import { render } from "../../../test/render.tsx";
import { DiscoveryControls } from "../discovery-controls.tsx";
import type { DiscoveryState } from "../../../lib/model-discovery.ts";
import type { DiscoveredModel } from "../../../hooks/use-model-provider-credentials.ts";

await i18nReady;
await i18n.changeLanguage("fr");

/** Only the count is read here; every other field is what the wire type requires. */
function detected(id: string): DiscoveredModel {
  return {
    id,
    label: null,
    context_window: null,
    max_tokens: null,
    input: null,
    reasoning: null,
    source: "endpoint",
  };
}

function listing(overrides: Partial<DiscoveryState> = {}): string {
  return render(
    <DiscoveryControls
      mode="list"
      discovery={{
        key: "k",
        outcome: "ok",
        models: [detected("gpt-6"), detected("gpt-6-mini")],
        truncated: false,
        ...overrides,
      }}
      isPending={false}
      onDiscover={() => {}}
      onManual={() => {}}
    />,
  );
}

describe("DiscoveryControls — what a listing reports about itself", () => {
  it("counts what it found and claims nothing is missing", () => {
    const html = listing();
    expect(html).toContain(settingsFr["models.form.discoverCount_other"].replace("{{count}}", "2"));
    expect(html).not.toContain(settingsFr["models.form.discoverTruncated"]);
  });

  it("says the count is short of what the endpoint serves", () => {
    expect(listing({ truncated: true })).toContain(settingsFr["models.form.discoverTruncated"]);
  });
});
