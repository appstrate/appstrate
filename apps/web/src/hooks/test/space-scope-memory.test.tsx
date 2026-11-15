// SPDX-License-Identifier: Apache-2.0

/**
 * « Tous les espaces » is remembered per account and org, and only that choice: a list opened
 * with it and no `spaceId` asks the org route straight away (one request, never the current
 * space's first); any other choice forgets it; an explicit param wins.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { render } = await import("../../test/render.tsx");
const { useSpaceFilter } = await import("../use-space-filter.ts");
const { usePaginatedRuns } = await import("../use-paginated-runs.ts");
const { allSpacesStore } = await import("../../stores/all-spaces-store.ts");
const { authStore } = await import("../../stores/auth-store.ts");
const { orgStore } = await import("../../stores/org-store.ts");
const { spaceStore } = await import("../../stores/space-store.ts");

const KEY = "u_1:org_1";
const admitsRuns = (permissions: readonly string[]) => permissions.includes("runs:read");
const spaces = ["spc_a", "spc_b"].map((id) => ({
  id,
  access: "member",
  permissions: ["runs:read"],
  personal: false,
  name: id,
}));

let stubs: { mockRestore: () => void }[] = [];
beforeEach(() => {
  // A static render reads each store's initial state; writes go to the live one.
  stubs = [
    spyOn(authStore, "getInitialState").mockReturnValue({
      ...authStore.getInitialState(),
      user: { id: "u_1", email: "u@example.test", emailVerified: true },
    }),
    spyOn(orgStore, "getInitialState").mockReturnValue({
      ...orgStore.getInitialState(),
      id: "org_1",
    }),
    spyOn(spaceStore, "getInitialState").mockReturnValue({
      ...spaceStore.getInitialState(),
      id: "spc_a",
    }),
    // A navigation outside an effect only warns.
    spyOn(console, "warn").mockImplementation(() => {}),
  ];
});
afterEach(() => {
  for (const stub of stubs) stub.mockRestore();
  allSpacesStore.getState().set(KEY, false);
});

function remember(on: boolean) {
  allSpacesStore.getState().set(KEY, on);
  stubs.push(
    spyOn(allSpacesStore, "getInitialState").mockReturnValue({
      ...allSpacesStore.getInitialState(),
      remembered: on ? { [KEY]: true } : {},
    }),
  );
}

/** Renders a runs list as the page does; answers the run-list keys it asked and its scope. */
function openRunsList(url = "/runs") {
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    ["get", "/api/spaces", { params: { header: { "X-Org-Id": "org_1" } } }],
    {
      object: "list",
      data: spaces,
    },
  );
  let scope: ReturnType<typeof useSpaceFilter>["scope"];
  function Page() {
    const filter = useSpaceFilter(admitsRuns);
    scope = filter.scope;
    usePaginatedRuns({ spaceIds: filter.spaceIds, limit: 15, offset: 0 });
    return null;
  }
  render(<Page />, { queryClient, initialEntries: [url] });
  const keys = queryClient
    .getQueryCache()
    .findAll({ queryKey: ["paginated-runs"] })
    .map((query) => query.queryKey.slice(1, 4));
  return { keys, scope: scope! };
}

describe("the remembered « all spaces »", () => {
  it("opens a list without `spaceId` on every space, with the org request only", () => {
    remember(true);
    expect(openRunsList().keys).toEqual([["org_1", "/orgs/runs", "spc_a,spc_b"]]);
  });

  it("leaves a list on the current space when nothing is remembered", () => {
    remember(false);
    expect(openRunsList().keys).toEqual([["org_1", "spc_a", "/runs"]]);
  });

  it("gives way to an explicit param", () => {
    remember(true);
    expect(openRunsList("/runs?spaceId=spc_b").keys).toEqual([["org_1", "/orgs/runs", "spc_b"]]);
  });

  it("is set by choosing every space, and forgotten by any other choice", () => {
    remember(false);
    const { scope } = openRunsList();
    scope.onChange(["spc_a", "spc_b"]);
    expect(allSpacesStore.getState().remembered[KEY]).toBe(true);
    scope.onChange(["spc_b"]);
    expect(allSpacesStore.getState().remembered[KEY]).toBeUndefined();
    scope.onChange(["spc_a", "spc_b"]);
    scope.onChange(["spc_a"]);
    expect(allSpacesStore.getState().remembered[KEY]).toBeUndefined();
  });

  it("names « Tous les espaces » on the trigger when the list spans them all", () => {
    remember(true);
    const { scope } = openRunsList();
    expect(scope.values).toEqual(["spc_a", "spc_b"]);
    expect(scope.allLabel).toBe("Tous les espaces");
  });
});
