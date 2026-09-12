// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { buildSettingsNavigation } from "../navigation";

type Features = Parameters<typeof buildSettingsNavigation>[0]["features"];

const ALL_FEATURES: Features = { oidc: true, billing: true, webhooks: true };
const NO_FEATURES: Features = { oidc: false, billing: false, webhooks: false };

function destinations(features: Features, granted: string[], canAuthorPackage = false) {
  const can = (permission: string) => granted.includes(permission);
  return buildSettingsNavigation({ can, canAuthorPackage, features }).flatMap((section) =>
    section.items.filter((item) => item.show !== false).map((item) => item.to),
  );
}

describe("unified settings navigation", () => {
  it("keeps collaborator SSO available independently of its activation state", () => {
    expect(destinations(ALL_FEATURES, ["oauth-clients:read"])).toContain("/org-settings/oauth");
  });

  it("offers an organisation entry only to someone who can act there", () => {
    // A guest holds `org:read`, `spaces:read`, `models:read` and `proxies:read`
    // so its runs work — none of which is a reason to open an administration
    // screen. Only the personal destination survives.
    const guest = destinations(ALL_FEATURES, [
      "org:read",
      "spaces:read",
      "models:read",
      "proxies:read",
    ]);
    expect(guest).toEqual(["/org-settings/mcp-access"]);

    // A member adds the directory and the role catalog, and nothing else.
    const member = destinations(ALL_FEATURES, [
      "org:read",
      "spaces:read",
      "models:read",
      "proxies:read",
      "members:read",
      "roles:read",
    ]);
    expect(member).toEqual([
      "/org-settings/members",
      "/org-settings/roles",
      "/org-settings/mcp-access",
    ]);

    // Authoring somewhere is what the library is for — anywhere, not only in
    // the space the caller happens to stand in.
    expect(destinations(ALL_FEATURES, [], true)).toContain("/org-settings/library");
    expect(destinations(ALL_FEATURES, ["skills:write"])).not.toContain("/org-settings/library");

    // Writing is what the infrastructure screens are for.
    const admin = destinations(ALL_FEATURES, ["org:settings", "spaces:write", "models:write"]);
    expect(admin).toContain("/org-settings/general");
    expect(admin).toContain("/org-settings/spaces");
    expect(admin).toContain("/org-settings/models");
    expect(admin).not.toContain("/org-settings/proxies");
    // `spaces:write` also governs a space's own auth screen, and says so.
    expect(admin).toContain("/workspace-settings/auth");
  });

  it("keeps a module's screen behind its module, whatever the permission", () => {
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

  it("keeps a space screen for whoever can act on it", () => {
    // An operator manages end-users; a viewer, who only reads them, is not
    // sent to a screen where every control is dead.
    expect(destinations(ALL_FEATURES, ["end-users:write"])).toContain(
      "/workspace-settings/end-users",
    );
    expect(destinations(ALL_FEATURES, ["end-users:read"])).not.toContain(
      "/workspace-settings/end-users",
    );
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
