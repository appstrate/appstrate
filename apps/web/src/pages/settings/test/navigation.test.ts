// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { isUnder, routeVerdict } from "../../../lib/route-access";
import {
  activeSettingsItem,
  firstSettingsPath,
  isSettingsIndex,
  SETTINGS_INDEX,
  settingsContentKey,
  settingsScopeFromPath,
  visibleSettingsSections,
} from "../navigation";

type Features = Record<string, boolean>;

const ALL_FEATURES: Features = { oidc: true, billing: true, webhooks: true };
const NO_FEATURES: Features = {};

function options(features: Features, granted: string[], inPersonalSpace = false) {
  const can = (permission: string) => granted.includes(permission);
  return {
    can,
    canReach: (path: Parameters<typeof routeVerdict>[0]) =>
      routeVerdict(path, can, features, inPersonalSpace) === "granted",
  };
}

function destinations(features: Features, granted: string[], inPersonalSpace = false) {
  return visibleSettingsSections(options(features, granted, inPersonalSpace)).flatMap((section) =>
    section.items.map((item) => item.to),
  );
}

const orgEntries = (paths: string[]) => paths.filter((path) => isUnder(path, "/org-settings"));

const GUEST = ["org:read", "spaces:read", "models:read", "proxies:read"];

describe("unified settings navigation", () => {
  it("keeps collaborator SSO available independently of its activation state", () => {
    expect(destinations(ALL_FEATURES, ["oauth-clients:read"])).toContain("/org-settings/oauth");
  });

  it("lists General to every member: leaving the organization lives there", () => {
    // A guest reads spaces, models and proxies so its runs resolve them; that
    // is no reason to list their administration screens.
    expect(orgEntries(destinations(ALL_FEATURES, GUEST))).toEqual(["/org-settings/general"]);

    const member = orgEntries(destinations(ALL_FEATURES, [...GUEST, "members:read", "roles:read"]));
    expect(member).toEqual([
      "/org-settings/general",
      "/org-settings/members",
      "/org-settings/roles",
    ]);

    const admin = destinations(ALL_FEATURES, [
      ...GUEST,
      "spaces:write",
      "models:write",
      "space-settings:write",
    ]);
    expect(admin).toContain("/org-settings/spaces");
    expect(admin).toContain("/org-settings/models");
    expect(admin).not.toContain("/org-settings/proxies");
    expect(admin).toContain("/workspace-settings/auth");
  });

  it("never lists a screen its route refuses, whatever the write grant", () => {
    // `spaces:write` without the route's `spaces:read` reaches nothing.
    expect(destinations(ALL_FEATURES, ["spaces:write"])).not.toContain("/org-settings/spaces");
  });

  it("keeps a module's screen behind its module, whatever the permission", () => {
    const withoutModules = destinations(NO_FEATURES, [
      "oauth-clients:read",
      "cli-sessions:read",
      "billing:read",
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

  it("lists end-users to whoever reads them", () => {
    expect(destinations(ALL_FEATURES, ["end-users:read"])).toContain(
      "/workspace-settings/end-users",
    );
    expect(destinations(ALL_FEATURES, [])).not.toContain("/workspace-settings/end-users");
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

  it("drops the team-space entries in a personal space, whatever the grants", () => {
    const all = [
      "space-settings:write",
      "space-members:read",
      "api-keys:read",
      "oauth-clients:read",
      "end-users:read",
      "webhooks:read",
    ];
    const shown = destinations(ALL_FEATURES, all, true);
    for (const path of [
      "/workspace-settings/members",
      "/workspace-settings/api-keys",
      "/workspace-settings/oauth",
      "/workspace-settings/end-users",
      "/workspace-settings/auth",
    ]) {
      expect(shown).not.toContain(path);
    }
    expect(shown).toContain("/workspace-settings/general");
    // A webhook pinned to a personal space is accepted (201), so its page stays.
    expect(shown).toContain("/workspace-settings/webhooks");
  });
});

describe("settings index", () => {
  const admin = visibleSettingsSections(
    options(ALL_FEATURES, [...GUEST, "space-settings:write", "api-keys:read"]),
  );

  it("opens each scope on its own first entry", () => {
    expect(firstSettingsPath(admin, "organization")).toBe("/org-settings/general");
    expect(firstSettingsPath(admin, "workspace")).toBe("/workspace-settings/general");
  });

  it("falls back to the rail's first entry when the scope lists none", () => {
    const guest = visibleSettingsSections(options(ALL_FEATURES, GUEST));
    expect(firstSettingsPath(guest, "workspace")).toBe("/org-settings/general");
    expect(firstSettingsPath([], "workspace")).toBeUndefined();
  });
});

describe("account section (/preferences)", () => {
  const OWN_ACCOUNT_PAGES = [
    "/preferences/general",
    "/preferences/appearance",
    "/preferences/security",
    "/preferences/devices",
    "/preferences/connections",
    "/preferences/mcp-access",
  ];

  it("is built for a caller with no organization or space permission", () => {
    const sections = visibleSettingsSections(options(NO_FEATURES, []));
    const account = sections.find((section) => section.scope === "account");
    expect(account?.items.map((item): string => item.to)).toEqual(OWN_ACCOUNT_PAGES);
    expect(firstSettingsPath(sections, "account")).toBe("/preferences/general");
  });

  it("lists the caller's model keys only where their route opens", () => {
    expect(destinations(NO_FEATURES, [])).not.toContain("/preferences/models");
    expect(destinations(NO_FEATURES, ["model-provider-credentials:read"])).toContain(
      "/preferences/models",
    );
  });

  it("sits in the same rail as the organization and workspace sections", () => {
    const sections = visibleSettingsSections(
      options(ALL_FEATURES, [...GUEST, "space-settings:write"]),
    );
    expect(sections.map((section) => section.scope)).toEqual([
      "organization",
      "workspace",
      "account",
    ]);
  });
});

describe("active settings entry", () => {
  const sections = visibleSettingsSections(options(ALL_FEATURES, GUEST));

  it("names the entry of the page shown, nested URLs included, in every scope", () => {
    expect(activeSettingsItem(sections, "/org-settings/general")?.to).toBe("/org-settings/general");
    expect(activeSettingsItem(sections, "/preferences/security")?.to).toBe("/preferences/security");
    expect(activeSettingsItem(sections, "/preferences/security/x")?.to).toBe(
      "/preferences/security",
    );
  });

  it("names none on a URL the rail does not list", () => {
    // A guest on /org-settings/members: the page is refused and the entry hidden.
    expect(activeSettingsItem(sections, "/org-settings/members")).toBeUndefined();
    expect(activeSettingsItem(sections, "/org-settings/unknown")).toBeUndefined();
    expect(activeSettingsItem(sections, "/preferences/generalx")).toBeUndefined();
  });
});

describe("index URLs", () => {
  it("treats every scope's root as an index, /preferences included", () => {
    for (const index of ["/org-settings", "/workspace-settings", "/preferences", "/preferences/"]) {
      expect(isSettingsIndex(index)).toBe(true);
    }
    expect(isSettingsIndex("/preferences/general")).toBe(false);
  });

  it("gives each page the index of its own scope, which the breadcrumb root links to", () => {
    expect(SETTINGS_INDEX[settingsScopeFromPath("/org-settings/models")]).toBe("/org-settings");
    expect(SETTINGS_INDEX[settingsScopeFromPath("/workspace-settings/webhooks/wh_1")]).toBe(
      "/workspace-settings",
    );
    expect(SETTINGS_INDEX[settingsScopeFromPath("/preferences/models")]).toBe("/preferences");
  });
});

describe("settings scope", () => {
  it("reads the scope off the URL, segment by segment", () => {
    expect(settingsScopeFromPath("/org-settings/models")).toBe("organization");
    expect(settingsScopeFromPath("/workspace-settings/end-users")).toBe("workspace");
    expect(settingsScopeFromPath("/preferences/models")).toBe("account");
    expect(settingsScopeFromPath("/preferences")).toBe("account");
  });

  it("remounts the content only when its own scope changes", () => {
    expect(settingsContentKey("/org-settings/models", "org-a", "ws-a")).toBe("organization:org-a");
    expect(settingsContentKey("/org-settings/models", "org-a", "ws-b")).toBe("organization:org-a");
    expect(settingsContentKey("/workspace-settings/end-users", "org-a", "ws-a")).toBe(
      "workspace:org-a:ws-a",
    );
    expect(settingsContentKey("/workspace-settings/end-users", "org-a", "ws-b")).toBe(
      "workspace:org-a:ws-b",
    );
    expect(settingsContentKey("/preferences/models", "org-a", "ws-a")).toBe("account:org-a");
    expect(settingsContentKey("/preferences/models", "org-a", "ws-b")).toBe("account:org-a");
  });
});
