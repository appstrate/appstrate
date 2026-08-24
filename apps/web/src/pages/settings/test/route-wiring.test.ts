// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf-8");

describe("unified settings route wiring", () => {
  it("keeps settings detail transitions inside the modal and carries its background", () => {
    const applications = read("../../org-settings/applications.tsx");
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
      'navigate("/org-settings/applications", { state: location.state })',
    );
  });

  it("opens billing as a routed modal and preserves gated redirects", () => {
    const billing = read("../../../components/sidebar-billing.tsx");
    expect(billing.match(/state=\{openAsModal\(location\)\}/g)).toHaveLength(2);

    const oauth = read("../../org-settings/oauth.tsx");
    expect(oauth).toContain('<NavigateKeepingState to="/org-settings/general" />');

    const agentTabs = read("../../../components/package-detail/agent-tabs.tsx");
    expect(agentTabs).toContain('to="/workspace-settings/api-keys"');
    expect(agentTabs).toContain("state={openAsModal(location)}");
  });

  it("preserves the modal background through every settings guard", () => {
    const guardedPages = [
      "../../org-settings/models.tsx",
      "../../org-settings/proxies.tsx",
      "../../org-settings/billing.tsx",
      "../../org-settings/oauth.tsx",
      "../../library-page.tsx",
      "../../org-settings/app/auth.tsx",
      "../../org-settings/app/oauth.tsx",
    ];

    for (const page of guardedPages) {
      const source = read(page);
      expect(source).not.toContain("<Navigate ");
      expect(source).toContain("<NavigateKeepingState ");
    }
  });
});
