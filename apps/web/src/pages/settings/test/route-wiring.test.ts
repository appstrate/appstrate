// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf-8");

describe("unified settings route wiring", () => {
  it("says a page whose module is off is unavailable, instead of redirecting", () => {
    const oauth = read("../../org-settings/oauth.tsx");
    expect(oauth).toContain("<UnavailableState />");
  });

  it("answers a settings guard with a refusal state, never a silent redirect", () => {
    const guardedPages = [
      "../../org-settings/models.tsx",
      "../../org-settings/proxies.tsx",
      "../../org-settings/billing.tsx",
      "../../org-settings/oauth.tsx",
      "../../org-settings/app/auth.tsx",
      "../../org-settings/space/oauth.tsx",
    ];

    for (const page of guardedPages) {
      const source = read(page);
      expect(source).not.toContain("<Navigate ");
      expect(source).toMatch(/<(NoAccessState|UnavailableState) \/>/);
    }
  });

  it("draws one title row with one actions slot, at every width", () => {
    // Two slots portal every page's actions twice: duplicate controls and test ids.
    const layout = read("../layout.tsx");
    expect(layout.match(/data-page-actions\b/g)).toHaveLength(1);
    const actions = read("../../../components/settings/settings-page-actions.tsx");
    expect(actions.match(/createPortal\(/g)).toHaveLength(1);
  });

  it("puts the API-key creation deed in the settings title slot", () => {
    const apiKeys = read("../../api-keys-page.tsx");
    expect(apiKeys).toContain("<SettingsPageActions>");
    expect(apiKeys.indexOf("<SettingsPageActions>")).toBeLessThan(apiKeys.indexOf("<DataTable"));
  });
});
