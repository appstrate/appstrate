// SPDX-License-Identifier: Apache-2.0

/**
 * What the bell reads on every page: the badge's unread count alone. The rows and the agent
 * names they show are read while the list is open — in « Tous les espaces » every one of them is
 * an organization-wide read.
 */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/" },
});

const { NotificationBell } = await import("../notification-bell.tsx");
const { memberSpaceClient, renderInSpace, testSpace } = await import("../../test/space-context.ts");
const i18nModule = await import("../../i18n.ts");
await i18nModule.i18nReady;

const SPACES = [
  testSpace("spc_a", ["agents:read", "runs:read"]),
  testSpace("spc_b", ["agents:read", "runs:read"]),
];

/** The paths the bell's enabled queries read, the bell closed. */
function readsOfClosedBell(overview: boolean): string[] {
  const queryClient = memberSpaceClient(SPACES);
  renderInSpace(<NotificationBell />, { overview, queryClient });
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
