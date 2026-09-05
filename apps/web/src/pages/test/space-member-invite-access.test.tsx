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

function pageFor(permissions: string[], cached = true) {
  const queryClient = new QueryClient();
  const org: components["schemas"]["Organization"] = {
    id: "org_inviter",
    name: "Inviter",
    slug: "inviter",
    role: "guest",
    permissions: [],
    createdAt: "2026-09-05T00:00:00Z",
  };
  const space: components["schemas"]["SpaceObject"] = {
    object: "space",
    id: "spc_inviter",
    orgId: org.id,
    name: "Inviter space",
    isDefault: true,
    settings: {},
    visibility: "open",
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
  const membersKey = $api.queryOptions("get", "/api/spaces/{id}/members", {
    params: { path: { id: space.id }, header },
  }).queryKey;
  const member: components["schemas"]["SpaceMemberObject"] = {
    object: "space_member",
    userId: "usr_private",
    name: "Private cached member",
    email: "private@example.com",
    org_role: "guest",
    source: "explicit",
    role: { kind: "preset", key: "viewer", name: "viewer" },
    created_at: null,
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
    const options = membersQuery?.options;
    return { html, queryEnabled: options && "enabled" in options ? options.enabled : undefined };
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
    expect(result.queryEnabled).toBe(true);
    expect(result.html).not.toContain('data-testid="add-space-member-button"');
  });

  it("refuses a caller holding neither permission before mounting the member page", () => {
    const result = pageFor([], false);
    expect(result.html).not.toContain('data-testid="add-space-member-button"');
    expect(result.html).not.toContain("Private cached member");
    expect(result.queryEnabled).toBeUndefined();
  });
});
