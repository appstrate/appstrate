// SPDX-License-Identifier: Apache-2.0

/**
 * Settings pages open on the route's read permission and draw each deed behind
 * the permission its own API route checks. Its deeds go to the shell's title slot.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { ReactElement } from "react";
import { QueryClient } from "@tanstack/react-query";
import { $api, type components } from "../../api/client.ts";
import { orgStore } from "../../stores/org-store.ts";
import { spaceStore } from "../../stores/space-store.ts";
import { render } from "../../test/render.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";
import { routeVerdict } from "../../lib/route-access.ts";

// The org General page reaches the auth client, which reads `window.location` at import.
installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { origin: "http://localhost" },
});
const { EndUsersPage } = await import("../end-users-page.tsx");
const { ApiKeysPage } = await import("../api-keys-page.tsx");
const { OrgSettingsGeneralPage } = await import("../org-settings/general.tsx");
const { OrgSettingsSpacesPage } = await import("../org-settings/spaces.tsx");
const { SettingsPageActionTargetProvider } =
  await import("../../components/settings/settings-page-actions.tsx");

await i18nReady;
await i18n.changeLanguage("fr");

const restores: Array<() => void> = [];
afterEach(() => {
  restores.splice(0).forEach((restore) => restore());
});

type Space = components["schemas"]["SpaceObject"];

function space(overrides: Partial<Space> = {}): Space {
  return {
    object: "space",
    id: "spc_team",
    orgId: "org_gates",
    name: "Equipe",
    icon: null,
    color: null,
    isDefault: false,
    settings: {},
    visibility: "open",
    default_role: "viewer",
    personal: false,
    access: "member",
    role: null,
    permissions: [],
    created_by: null,
    createdAt: "2026-09-05T00:00:00Z",
    updatedAt: "2026-09-05T00:00:00Z",
    ...overrides,
  };
}

function renderAs(
  node: ReactElement,
  {
    permissions,
    role = "member",
    spaces = [space()],
  }: {
    permissions: string[];
    role?: components["schemas"]["Organization"]["role"];
    spaces?: Space[];
  },
): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  const org: components["schemas"]["Organization"] = {
    id: "org_gates",
    name: "Gates",
    slug: "gates",
    icon: null,
    color: null,
    role,
    deleting_at: null,
    permissions,
    createdAt: "2026-09-05T00:00:00Z",
  };
  const orgSnapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: org.id,
  });
  const spaceSnapshot = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: spaces[0]!.id,
  });
  restores.push(
    () => orgSnapshot.mockRestore(),
    () => spaceSnapshot.mockRestore(),
  );
  queryClient.setQueryData(["orgs"], [org]);
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header: { "X-Org-Id": org.id } } })
      .queryKey,
    { object: "list", data: spaces, hasMore: false },
  );
  return render(node, { queryClient });
}

const ACTIONS_TRIGGER = "data-page-actions-trigger";

describe("end-users settings", () => {
  it("lists end-users to a reader, without a deed", () => {
    const html = renderAs(<EndUsersPage />, { permissions: ["end-users:read"] });
    expect(html).toContain("Rechercher");
    expect(html).not.toContain(ACTIONS_TRIGGER);
    expect(html).not.toContain("Nouvel end-user");
  });

  it("offers creation to whoever may write them", () => {
    const html = renderAs(<EndUsersPage />, {
      permissions: ["end-users:read", "end-users:write"],
    });
    expect(html).toContain(ACTIONS_TRIGGER);
  });
});

describe("the organization's spaces", () => {
  const orphan = space({
    id: "spc_orphan",
    name: "Ancien",
    personal: true,
    visibility: "private",
    orphaned_at: "2026-09-20T00:00:00Z",
  });

  it("offers the sweep of an orphan to whoever may delete spaces", () => {
    // `POST /api/spaces/{id}/sweep-now` is guarded by `spaces:delete`.
    const html = renderAs(<OrgSettingsSpacesPage />, {
      permissions: ["spaces:read", "spaces:delete"],
      spaces: [space(), orphan],
    });
    expect(html).toContain("Plus d’actions pour");
  });

  it("offers an orphan no act to a reader", () => {
    const html = renderAs(<OrgSettingsSpacesPage />, {
      permissions: ["spaces:read"],
      spaces: [space(), orphan],
    });
    expect(html).not.toContain("Plus d’actions pour");
  });
});

describe("the organization's general settings", () => {
  /** The appearance picker's icon field: drawn for every member, editable by `org:update` only. */
  const iconFieldDisabled = (html: string) =>
    /disabled=""/.test(html.match(/<button[^>]*role="combobox"[^>]*>/)?.[0] ?? "");

  it("lets a member leave without drawing the administration controls", () => {
    const html = renderAs(<OrgSettingsGeneralPage />, { permissions: ["org:read"] });
    expect(html).toContain('data-testid="leave-org-button"');
    expect(iconFieldDisabled(html)).toBe(true);
    expect(html).not.toContain("Distribution");
    expect(html).not.toContain('data-testid="delete-org-button"');
  });

  it("draws the administration controls for whoever holds them", () => {
    const html = renderAs(<OrgSettingsGeneralPage />, {
      permissions: ["org:read", "org:update", "org:settings", "org:delete"],
      role: "owner",
    });
    expect(html).toContain("Apparence");
    expect(iconFieldDisabled(html)).toBe(false);
    expect(html).toContain("Distribution");
    expect(html).toContain('data-testid="delete-org-button"');
  });
});

describe("a settings page whose module is off", () => {
  // The route gate answers « absent » for these before the page mounts.
  it("leaves a page whose module is off to its route's feature", () => {
    const all = () => true;
    for (const path of [
      "/org-settings/billing",
      "/org-settings/oauth",
      "/workspace-settings/oauth",
      "/workspace-settings/auth",
    ] as const) {
      expect(routeVerdict(path, all, {}, false)).toBe("absent");
    }
  });
});

describe("a settings page's deeds", () => {
  const apiKeys = () => <ApiKeysPage />;
  const permissions = ["api-keys:read", "api-keys:create"];

  it("render in place outside the settings shell", () => {
    expect(renderAs(apiKeys(), { permissions })).toContain(ACTIONS_TRIGGER);
  });

  it("render only in the shell's title slot, never a second time in the page", () => {
    // `null` is the slot before it mounts: nothing may fall back to the page body.
    const html = renderAs(
      <SettingsPageActionTargetProvider target={null}>
        {apiKeys()}
      </SettingsPageActionTargetProvider>,
      { permissions },
    );
    expect(html).not.toContain(ACTIONS_TRIGGER);
    expect(html).toContain(i18n.t("orgSettings.tabApiKeys", { ns: "settings" }));
  });
});
