// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api, type components } from "../../api/client.ts";
import { RequirePermission } from "../../components/require-permission.tsx";
import { OrgSettingsSpaceMembersPage } from "../org-settings/space/members.tsx";
import { orgStore } from "../../stores/org-store.ts";
import { spaceStore } from "../../stores/space-store.ts";
import { render } from "../../test/render.tsx";
import { i18nReady } from "../../i18n.ts";

await i18nReady;

function pageFor(
  permissions: string[],
  cached = true,
  options: {
    memberOrgRole?: components["schemas"]["SpaceMemberObject"]["org_role"];
    memberSource?: components["schemas"]["SpaceMemberObject"]["source"];
    visibility?: components["schemas"]["SpaceObject"]["visibility"];
    rolesError?: boolean;
    orgPermissions?: string[];
    invitations?: components["schemas"]["OrgInvitationInfo"][];
  } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  const org: components["schemas"]["Organization"] = {
    id: "org_inviter",
    name: "Inviter",
    slug: "inviter",
    role: "guest",
    permissions: options.orgPermissions ?? [],
    createdAt: "2026-09-05T00:00:00Z",
  };
  const space: components["schemas"]["SpaceObject"] = {
    object: "space",
    id: "spc_inviter",
    orgId: org.id,
    name: "Inviter space",
    isDefault: true,
    settings: {},
    visibility: options.visibility ?? "open",
    default_role: "viewer",
    access: "member",
    role: null,
    permissions,
    created_by: null,
    createdAt: org.createdAt,
    updatedAt: org.createdAt,
  };
  // SSR reads Zustand's hydration snapshot, rather than its live browser state.
  // Only the selected IDs are supplied; permissions still come from the real queries.
  const orgSnapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: org.id,
  });
  const spaceSnapshot = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: space.id,
  });
  const header = { "X-Org-Id": org.id };
  queryClient.setQueryData(["orgs"], [org]);
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header } }).queryKey,
    { object: "list", data: [space], hasMore: false },
  );
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces/{id}", { params: { path: { id: space.id }, header } })
      .queryKey,
    space,
  );
  if (options.rolesError) {
    const rolesKey = $api.queryOptions("get", "/api/spaces/{id}/roles", {
      params: { path: { id: space.id }, header },
    }).queryKey;
    queryClient.setQueryData(rolesKey, { object: "list", data: [], hasMore: false });
    queryClient
      .getQueryCache()
      .find({ queryKey: rolesKey })!
      .setState({
        data: undefined,
        status: "error",
        error: new Error("Catalog unavailable"),
        fetchStatus: "idle",
      });
  }
  if (options.invitations) {
    const detail: components["schemas"]["OrgDetail"] = {
      id: org.id,
      name: org.name,
      slug: org.slug,
      createdAt: org.createdAt,
      storage: { used_bytes: 0, limit_bytes: null, effective_limit_bytes: null },
      members: [],
      invitations: options.invitations,
    };
    queryClient.setQueryData(
      $api.queryOptions("get", "/api/orgs/{orgId}", { params: { path: { orgId: org.id } } })
        .queryKey,
      detail,
    );
  }
  const membersKey = $api.queryOptions("get", "/api/spaces/{id}/members", {
    params: { path: { id: space.id }, header },
  }).queryKey;
  const member: components["schemas"]["SpaceMemberObject"] = {
    object: "space_member",
    userId: "usr_private",
    name: "Private cached member",
    email: "private@example.com",
    org_role: options.memberOrgRole ?? "guest",
    source: options.memberSource ?? "explicit",
    role:
      options.memberSource === "org_role"
        ? { kind: "preset", key: "admin", name: "admin" }
        : { kind: "preset", key: "viewer", name: "viewer" },
    createdAt: null,
  };
  if (cached)
    queryClient.setQueryData(membersKey, { object: "list", data: [member], hasMore: false });
  try {
    const html = render(
      <RequirePermission permission={["space-members:read", "space-members:invite"]}>
        <OrgSettingsSpaceMembersPage />
      </RequirePermission>,
      { queryClient },
    );
    const membersQuery = queryClient.getQueryCache().find({ queryKey: membersKey });
    const queryOptions = membersQuery?.options;
    return {
      html,
      queryEnabled: queryOptions && "enabled" in queryOptions ? queryOptions.enabled : undefined,
    };
  } finally {
    orgSnapshot.mockRestore();
    spaceSnapshot.mockRestore();
  }
}

describe("invite-only space member access", () => {
  it("opens the add action but disables member fetching and hides previously cached rows", () => {
    const result = pageFor(["space-members:invite"]);
    expect(result.html).toContain('data-testid="add-space-member-button"');
    expect(result.queryEnabled).toBe(false);
    expect(result.html).not.toContain("Private cached member");
    expect(result.html).not.toContain("private@example.com");
    expect(result.html).not.toContain("<table");
  });

  it("does not block the invite action behind a member loading or empty state", () => {
    const result = pageFor(["space-members:invite"], false);
    expect(result.html).toContain('data-testid="add-space-member-button"');
    expect(result.queryEnabled).toBe(false);
    expect(result.html).not.toContain("<table");
  });

  it("still loads and renders members for readers, without offering an invite action", () => {
    const result = pageFor(["space-members:read"]);
    expect(result.html).toContain("Private cached member");
    expect(result.html).toContain("Attribué");
    expect(result.queryEnabled).toBe(true);
    expect(result.html).not.toContain('data-testid="add-space-member-button"');
  });

  it("refuses a caller holding neither permission before mounting the member page", () => {
    const result = pageFor([], false);
    expect(result.html).not.toContain('data-testid="add-space-member-button"');
    expect(result.html).not.toContain("Private cached member");
    expect(result.queryEnabled).toBeUndefined();
  });

  it("labels removal as restoring the default only for standard users in an open space", () => {
    const permissions = ["space-members:read", "space-members:remove"];
    const standard = pageFor(permissions, true, { memberOrgRole: "member" }).html;
    expect(standard).toContain("Rétablir le rôle par défaut");
    expect(standard).not.toContain("Retirer l'accès");
    const guest = pageFor(permissions).html;
    expect(guest).toContain("Retirer l'accès");
    expect(guest).not.toContain("Rétablir le rôle par défaut");
    const closed = pageFor(permissions, true, {
      memberOrgRole: "member",
      visibility: "closed",
    }).html;
    expect(closed).toContain("Retirer l'accès");
  });

  it("names an organization role's reach without borrowing the space admin preset label", () => {
    const html = pageFor(["space-members:read"], true, {
      memberOrgRole: "owner",
      memberSource: "org_role",
    }).html;
    expect(html).toContain("Propriétaire de l'organisation");
    expect(html).toContain("Rôle d'organisation");
    expect(html).not.toContain("Administrateur de l'espace");
  });

  it("lists the pending invitations that target this space, and only for organization inviters", () => {
    const invitations: components["schemas"]["OrgInvitationInfo"][] = [
      {
        id: "inv_here",
        email: "guest-here@example.com",
        role: "guest",
        space_assignments: [{ space_id: "spc_inviter", preset_role: "viewer" }],
        token: "tok_here",
        expiresAt: "2026-09-12T00:00:00Z",
        createdAt: "2026-09-05T00:00:00Z",
      },
      {
        id: "inv_elsewhere",
        email: "guest-elsewhere@example.com",
        role: "guest",
        space_assignments: [{ space_id: "spc_other", preset_role: "viewer" }],
        token: "tok_elsewhere",
        expiresAt: "2026-09-12T00:00:00Z",
        createdAt: "2026-09-05T00:00:00Z",
      },
    ];
    const inviter = pageFor(["space-members:read"], true, {
      orgPermissions: ["members:invite"],
      invitations,
    }).html;
    expect(inviter).toContain("Invitations en attente");
    expect(inviter).toContain("guest-here@example.com");
    expect(inviter).not.toContain("guest-elsewhere@example.com");
    const reader = pageFor(["space-members:read"], true, { invitations }).html;
    expect(reader).not.toContain("Invitations en attente");
    expect(reader).not.toContain("guest-here@example.com");
  });

  it("reports role catalog errors with a retry while keeping readable members visible", () => {
    const result = pageFor(["space-members:read", "space-members:invite"], true, {
      rolesError: true,
    });
    expect(result.html).toContain("Impossible de charger les rôles disponibles.");
    expect(result.html).toContain("Réessayer");
    expect(result.html).toContain("Private cached member");
    expect(result.html).not.toContain('aria-label="Rôle de Private cached member');
  });
});
