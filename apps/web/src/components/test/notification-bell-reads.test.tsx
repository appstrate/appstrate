// SPDX-License-Identifier: Apache-2.0

/**
 * What the bell reads on every page: the badge's unread count alone. The rows and the agent
 * names they show are read while the list is open — in « Tous les espaces » every one of them is
 * an organization-wide read polled at the lists' pace.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/" },
});

const { $api } = await import("../../api/client.ts");
const { NotificationBell } = await import("../notification-bell.tsx");
const { orgStore } = await import("../../stores/org-store.ts");
const { spaceStore } = await import("../../stores/space-store.ts");
const { authStore } = await import("../../stores/auth-store.ts");
const { overviewStore } = await import("../../stores/overview-store.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");
await i18nModule.i18nReady;

const ORG_ID = "org_bell";
const space = (id: string, permissions: string[]) => ({
  id,
  access: "member",
  permissions,
  personal: false,
  isDefault: id === "spc_a",
  name: id,
});
const SPACES = [
  space("spc_a", ["agents:read", "runs:read"]),
  space("spc_b", ["agents:read", "runs:read"]),
];

/** The paths the bell's enabled queries read, the bell closed. */
function readsOfClosedBell(overview: boolean): string[] {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  queryClient.setQueryData(
    ["orgs"],
    [{ id: ORG_ID, name: "Bell", slug: "bell", role: "owner", permissions: [] }],
  );
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header: { "X-Org-Id": ORG_ID } } })
      .queryKey,
    { object: "list", hasMore: false, data: SPACES },
  );
  const stubs = [
    spyOn(orgStore, "getInitialState").mockReturnValue({
      ...orgStore.getInitialState(),
      id: ORG_ID,
    }),
    spyOn(spaceStore, "getInitialState").mockReturnValue({
      ...spaceStore.getInitialState(),
      id: "spc_a",
    }),
    spyOn(authStore, "getInitialState").mockReturnValue({
      ...authStore.getInitialState(),
      user: { id: "u_bell", email: "u@example.test", emailVerified: true },
    }),
    spyOn(overviewStore, "getInitialState").mockReturnValue({
      ...overviewStore.getInitialState(),
      chosen: overview ? { [`u_bell:${ORG_ID}`]: true } : {},
    }),
  ];
  try {
    render(<NotificationBell />, { queryClient });
  } finally {
    for (const stub of stubs) stub.mockRestore();
  }
  return queryClient
    .getQueryCache()
    .findAll()
    .filter((query) => (query.options as { enabled?: unknown }).enabled !== false)
    .map((query) =>
      query.queryKey[0] === "get" ? String(query.queryKey[1]) : String(query.queryKey[0]),
    )
    .filter((path) => path !== "orgs" && path !== "/api/spaces");
}

describe("the closed bell", () => {
  it("reads only the unread count across spaces in « Tous les espaces »", () => {
    expect(readsOfClosedBell(true)).toEqual(["/api/orgs/{orgId}/notifications/unread-count"]);
  });

  it("reads only the working space's count out of the mode", () => {
    expect(readsOfClosedBell(false)).toEqual(["/api/notifications/unread-count"]);
  });
});
