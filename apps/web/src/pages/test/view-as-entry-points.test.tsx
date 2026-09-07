// SPDX-License-Identifier: Apache-2.0

/**
 * The two entry points into a role preview, and the persona they commit.
 *
 * What is asserted here is what this harness can see. The dialog itself is a
 * Radix `Dialog`, and its selects are Radix `Select`s — both render through
 * portals, so `renderToStaticMarkup` returns an empty string for the whole
 * dialog. Its interactive half (the radio options, the space defaulting to the
 * current one, the role list) is therefore covered by
 * `e2e/tests/rbac/view-as.ui.spec.ts`, in a browser. What lives here is
 * everything that is decided OUTSIDE the portal: who sees a trigger at all, and
 * the exact persona a submit commits.
 */

import { afterAll, describe, it, expect, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { OrgRole } from "@appstrate/shared-types";
import type { components } from "../../api/client.ts";

/**
 * The roles page reads `window.__APP_CONFIG__` (the `custom_roles` feature) at
 * render, and the stores read `localStorage` at module init — so both globals
 * are installed before the dynamic imports below. `document` stays absent,
 * which is what keeps the portals inert rather than crashing.
 */
class FakeStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  getItem(key: string): string | null {
    return this.m.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.m.set(key, value);
  }
  removeItem(key: string): void {
    this.m.delete(key);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
}
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const fakeStorage = new FakeStorage();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: fakeStorage });
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    __APP_CONFIG__: { features: { custom_roles: true }, trustedOrigins: [] },
    localStorage: fakeStorage,
  },
});

// Restored so a suite that runs after this one in the same process still sees
// the DOM-less environment the harness promises.
afterAll(() => {
  for (const [name, descriptor] of [
    ["localStorage", previousStorage],
    ["window", previousWindow],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const { $api } = await import("../../api/client.ts");
const { OrgSettingsRolesPage } = await import("../org-settings/roles.tsx");
const { OrgSettingsSpaceMembersPage } = await import("../org-settings/space/members.tsx");
const { orgStore } = await import("../../stores/org-store.ts");
const { spaceStore } = await import("../../stores/space-store.ts");
const { toViewAsPersona } = await import("../../stores/view-as-store.ts");
const { render } = await import("../../test/render.tsx");
const { i18nReady } = await import("../../i18n.ts");

await i18nReady;

const ORG_ID = "org_a";
const SPACE_ID = "spc_1";
const header = { "X-Org-Id": ORG_ID };

function space(): components["schemas"]["SpaceObject"] {
  return {
    object: "space",
    id: SPACE_ID,
    orgId: ORG_ID,
    name: "Marketing",
    isDefault: true,
    settings: {},
    visibility: "open",
    default_role: "viewer",
    access: "member",
    role: null,
    permissions: ["space-members:read", "space-members:invite"],
    created_by: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function preset(key: string): components["schemas"]["RoleObject"] {
  return {
    object: "role",
    kind: "preset",
    id: null,
    key,
    name: key,
    description: null,
    permissions: [],
    created_at: null,
    updated_at: null,
  };
}

/** Seed the caches both settings pages read, as the given organization role. */
function seed(orgRole: OrgRole): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  const org: components["schemas"]["Organization"] = {
    id: ORG_ID,
    name: "Acme",
    slug: "acme",
    role: orgRole,
    permissions: ["roles:read", "members:read", "space-members:read", "space-members:invite"],
    createdAt: "2026-01-01T00:00:00Z",
  };
  queryClient.setQueryData(["orgs"], [org]);
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header } }).queryKey,
    { object: "list", data: [space()], hasMore: false },
  );
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces/{id}", { params: { path: { id: SPACE_ID }, header } })
      .queryKey,
    space(),
  );
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/roles", { params: { header } }).queryKey,
    {
      object: "list",
      data: [preset("admin"), preset("viewer")],
      hasMore: false,
    },
  );
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces/{id}/roles", {
      params: { path: { id: SPACE_ID }, header },
    }).queryKey,
    { object: "list", data: [preset("viewer")], hasMore: false },
  );
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces/{id}/members", {
      params: { path: { id: SPACE_ID }, header },
    }).queryKey,
    { object: "list", data: [], hasMore: false },
  );
  return queryClient;
}

/** SSR reads Zustand's hydration snapshot, not its live state. */
function renderAs(orgRole: OrgRole, node: Parameters<typeof render>[0]): string {
  const orgSnapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  const spaceSnapshot = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: SPACE_ID,
  });
  try {
    return render(node, { queryClient: seed(orgRole) });
  } finally {
    orgSnapshot.mockRestore();
    spaceSnapshot.mockRestore();
  }
}

describe("trigger visibility", () => {
  // Eligibility is the server's rule (`validateViewAs`): owner or admin, and a
  // role rather than a permission, because "a preview only removes" holds only
  // while the previewer outranks every persona.
  it.each(["owner", "admin"] as const)("offers the roles-page trigger to an %s", (orgRole) => {
    const html = renderAs(orgRole, <OrgSettingsRolesPage />);
    expect(html).toContain('data-testid="view-as-button"');
    expect(html).toContain("Prévisualiser un rôle");
  });

  it.each(["member", "guest"] as const)("hides the roles-page trigger from a %s", (orgRole) => {
    expect(renderAs(orgRole, <OrgSettingsRolesPage />)).not.toContain(
      'data-testid="view-as-button"',
    );
  });

  it("offers the space-members trigger to an owner and hides it from a member", () => {
    const asOwner = renderAs("owner", <OrgSettingsSpaceMembersPage />);
    expect(asOwner).toContain('data-testid="view-as-space-button"');
    expect(asOwner).toContain("Prévisualiser un rôle");
    // The "Ajouter un membre" action is unaffected — the two live side by side.
    expect(asOwner).toContain('data-testid="add-space-member-button"');

    expect(renderAs("member", <OrgSettingsSpaceMembersPage />)).not.toContain(
      'data-testid="view-as-space-button"',
    );
  });
});

describe("the persona a submit commits", () => {
  const marketing = { id: SPACE_ID, name: "Marketing" };
  const viewer = { value: "preset:viewer", label: "Lecteur" };

  it("carries the space half with the labels the banner will show", () => {
    expect(toViewAsPersona(ORG_ID, "member", marketing, viewer)).toEqual({
      orgId: ORG_ID,
      orgRole: "member",
      space: {
        spaceId: SPACE_ID,
        role: "preset:viewer",
        roleLabel: "Lecteur",
        spaceName: "Marketing",
      },
    });
  });

  it("addresses a custom role by id, the way the header carries it", () => {
    const custom = { value: "custom:srl_1", label: "Support" };
    expect(toViewAsPersona(ORG_ID, "guest", marketing, custom).space).toEqual({
      spaceId: SPACE_ID,
      role: "custom:srl_1",
      roleLabel: "Support",
      spaceName: "Marketing",
    });
  });

  it("omits the space half unless BOTH the space and a grantable role are known", () => {
    // The header's `space` and `role` are optional as a pair; a role the
    // space's catalog does not offer is not previewable there.
    expect(toViewAsPersona(ORG_ID, "guest", undefined, undefined).space).toBeNull();
    expect(toViewAsPersona(ORG_ID, "guest", marketing, undefined).space).toBeNull();
    expect(toViewAsPersona(ORG_ID, "guest", undefined, viewer).space).toBeNull();
  });
});
