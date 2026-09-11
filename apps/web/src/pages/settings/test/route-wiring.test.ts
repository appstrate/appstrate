// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf-8");

describe("unified settings route wiring", () => {
  it("keeps settings detail transitions inside the modal and carries its background", () => {
    const applications = read("../../org-settings/spaces.tsx");
    expect(applications).toContain(
      'navigate("/workspace-settings/general", { state: location.state })',
    );

    const webhooks = read("../../../modules/webhooks/pages/webhooks-page.tsx");
    expect(webhooks).toContain("rowHref={(wh) => `/workspace-settings/webhooks/${wh.id}`}");
    expect(webhooks).toContain("rowState={() => location.state}");

    const webhookSettings = read("../../../modules/webhooks/components/webhook-settings-tab.tsx");
    expect(webhookSettings).toContain(
      'navigate("/workspace-settings/webhooks", { state: location.state })',
    );

    const workspaceGeneral = read("../../org-settings/app/general.tsx");
    expect(workspaceGeneral).toContain(
      'navigate("/org-settings/spaces", { state: location.state })',
    );
  });

  it("preserves gated redirects", () => {
    // Billing lost its sidebar entry (the credits gauge left the nav on
    // 2026-08-20); it is reached from the settings rail like every other
    // org surface, which `navigation.ts` wires and the rail opens as an
    // overlay on its own.
    const oauth = read("../../org-settings/oauth.tsx");
    expect(oauth).toContain('<NavigateKeepingState to="/org-settings/general" />');

    const agentTabs = read("../../../components/package-detail/agent-tabs.tsx");
    expect(agentTabs).toContain('to="/workspace-settings/api-keys"');
    expect(agentTabs).toContain("state={openAsModal(location)}");
  });

  it("preserves the modal background through every settings guard", () => {
    // `library-page.tsx` left this list when the org-wide gate gave way to a
    // per-space one: the page now renders for everyone and each install
    // checkbox carries its own permission, so there is no redirect to preserve.
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
      expect(source).toContain("<NavigateKeepingState ");
    }
  });

  it("puts the API-key creation deed in the settings title slot", () => {
    const apiKeys = read("../../api-keys-page.tsx");
    expect(apiKeys).toContain("<SettingsPageActions>");
    expect(apiKeys.indexOf("<SettingsPageActions>")).toBeLessThan(apiKeys.indexOf("<DataTable"));
  });
});
