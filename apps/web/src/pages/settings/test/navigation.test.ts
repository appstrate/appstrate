// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { buildSettingsNavigation } from "../navigation";

function destinations(options: Parameters<typeof buildSettingsNavigation>[0]) {
  return buildSettingsNavigation(options).flatMap((section) =>
    section.items.filter((item) => item.show !== false).map((item) => item.to),
  );
}

describe("unified settings navigation", () => {
  it("keeps collaborator SSO available to an admin independently of its activation state", () => {
    const paths = destinations({
      isAdmin: true,
      features: { oidc: true, billing: false, webhooks: false },
    });

    expect(paths).toContain("/org-settings/oauth");
  });

  it("preserves the existing feature and permission gates", () => {
    const memberPaths = destinations({
      isAdmin: false,
      features: { oidc: true, billing: true, webhooks: true },
    });
    expect(memberPaths).toContain("/org-settings/general");
    expect(memberPaths).toContain("/org-settings/mcp-access");
    expect(memberPaths).toContain("/org-settings/billing");
    expect(memberPaths).not.toContain("/org-settings/models");
    expect(memberPaths).not.toContain("/org-settings/library");
    expect(memberPaths).not.toContain("/org-settings/oauth");
    expect(memberPaths.some((path) => path.startsWith("/workspace-settings/"))).toBe(false);

    const adminWithoutModules = destinations({
      isAdmin: true,
      features: { oidc: false, billing: false, webhooks: false },
    });
    expect(adminWithoutModules).not.toContain("/org-settings/oauth");
    expect(adminWithoutModules).not.toContain("/org-settings/cli-sessions");
    expect(adminWithoutModules).not.toContain("/workspace-settings/oauth");
    expect(adminWithoutModules).not.toContain("/workspace-settings/webhooks");
    expect(adminWithoutModules).toContain("/workspace-settings/general");
    expect(adminWithoutModules).toContain("/org-settings/library");
  });
});
