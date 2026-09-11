// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { buildSettingsNavigation } from "../navigation";

type Features = Parameters<typeof buildSettingsNavigation>[0]["features"];

const ALL_FEATURES: Features = { oidc: true, billing: true, webhooks: true };
const NO_FEATURES: Features = { oidc: false, billing: false, webhooks: false };

function destinations(features: Features, granted: string[]) {
  const can = (permission: string) => granted.includes(permission);
  return buildSettingsNavigation({ can, features }).flatMap((section) =>
    section.items.filter((item) => item.show !== false).map((item) => item.to),
  );
}

describe("unified settings navigation", () => {
  it("keeps collaborator SSO available independently of its activation state", () => {
    expect(destinations(ALL_FEATURES, ["oauth-clients:read"])).toContain("/org-settings/oauth");
  });

  it("gates every entry on the permission its route checks", () => {
    // A guest reads the org and its spaces, and nothing it administers.
    const guest = destinations(ALL_FEATURES, ["org:read", "spaces:read"]);
    expect(guest).toContain("/org-settings/general");
    expect(guest).toContain("/org-settings/spaces");
    expect(guest).toContain("/org-settings/library");
    expect(guest).toContain("/org-settings/mcp-access");
    for (const path of [
      "/org-settings/members",
      "/org-settings/models",
      "/org-settings/oauth",
      "/org-settings/billing",
    ]) {
      expect(guest).not.toContain(path);
    }
    expect(guest.some((path) => path.startsWith("/workspace-settings/"))).toBe(false);

    // Holding the permission is not enough when the module behind it is off.
    const withoutModules = destinations(NO_FEATURES, [
      "oauth-clients:read",
      "cli-sessions:read",
      "billing:read",
      "spaces:write",
      "webhooks:read",
      "space-settings:write",
    ]);
    expect(withoutModules).not.toContain("/org-settings/oauth");
    expect(withoutModules).not.toContain("/org-settings/cli-sessions");
    expect(withoutModules).not.toContain("/org-settings/billing");
    expect(withoutModules).not.toContain("/workspace-settings/auth");
    expect(withoutModules).not.toContain("/workspace-settings/oauth");
    expect(withoutModules).not.toContain("/workspace-settings/webhooks");
    expect(withoutModules).toContain("/workspace-settings/general");
  });

  it("opens webhooks on either level's read permission", () => {
    expect(destinations(ALL_FEATURES, ["org-webhooks:read"])).toContain(
      "/workspace-settings/webhooks",
    );
  });

  it("shows the RBAC screens exactly to the permissions their routes check", () => {
    const none = destinations(NO_FEATURES, []);
    expect(none).not.toContain("/org-settings/roles");
    expect(none).not.toContain("/workspace-settings/members");

    const granted = destinations(NO_FEATURES, ["roles:read", "space-members:read"]);
    expect(granted).toContain("/org-settings/roles");
    expect(granted).toContain("/workspace-settings/members");

    // A guest inviter reaches the members page without reading the roster.
    expect(destinations(NO_FEATURES, ["space-members:invite"])).toContain(
      "/workspace-settings/members",
    );
  });
});
