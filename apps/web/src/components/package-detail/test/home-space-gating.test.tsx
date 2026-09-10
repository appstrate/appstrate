// SPDX-License-Identifier: Apache-2.0

/**
 * The two SPA rules that read a package's home space (RBAC spec §6.9): which
 * spaces the "move" dialog may offer, and what `useHomeSpacePermission`
 * answers for a home it does not know yet.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
});

const { $api } = await import("../../../api/client.ts");
const { orgStore } = await import("../../../stores/org-store.ts");
const { render } = await import("../../../test/render.tsx");
const { useHomeSpacePermission } = await import("../../../hooks/use-permissions.ts");
const { writableDestinations } = await import("../../../lib/package-home.ts");
const i18nModule = await import("../../../i18n.ts");

await i18nModule.i18nReady;

const ORG_ID = "org_a";

type Space = { id: string; name: string; permissions: string[] };

const space = (id: string, permissions: string[]): Space => ({ id, name: id, permissions });

describe("writableDestinations", () => {
  const spaces = [
    space("spc_home", ["skills:write"]),
    space("spc_other", ["skills:write"]),
    space("spc_reader", ["skills:read"]),
    space("spc_unjoined", []),
  ];

  it("offers the spaces where the caller may author this type, minus the current home", () => {
    expect(writableDestinations(spaces, "skill", "spc_home").map((s) => s.id)).toEqual([
      "spc_other",
    ]);
  });

  it("asks for the type's own permission, not any write", () => {
    // `agents:write` is a different resource: the same four spaces offer nothing.
    expect(writableDestinations(spaces, "agent", "spc_home")).toEqual([]);
  });

  it("offers every writable space when the package is in the organization catalog", () => {
    expect(writableDestinations(spaces, "skill", null).map((s) => s.id)).toEqual([
      "spc_home",
      "spc_other",
    ]);
  });

  it("offers nothing while the space list is loading", () => {
    expect(writableDestinations(undefined, "skill", "spc_home")).toEqual([]);
  });
});

/** Renders the hook's verdict for one permission as `yes` / `no`. */
function Gate({ homeSpaceId }: { homeSpaceId: string | null | undefined }) {
  const canInHome = useHomeSpacePermission(homeSpaceId);
  return <span>{canInHome("skills:write") ? "yes" : "no"}</span>;
}

function verdict(homeSpaceId: string | null | undefined, orgRole: "owner" | "member"): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  // `["orgs"]` is the legacy key `useOrg` owns; the space list is a typed-client
  // key and carries the org header the scope hook puts in it.
  queryClient.setQueryData(["orgs"], [{ id: ORG_ID, role: orgRole, permissions: [] }]);
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header: { "X-Org-Id": ORG_ID } } })
      .queryKey,
    { object: "list", data: [space("spc_home", ["skills:write"])], hasMore: false },
  );
  const snapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  try {
    return render(<Gate homeSpaceId={homeSpaceId} />, { queryClient }).includes("yes")
      ? "yes"
      : "no";
  } finally {
    snapshot.mockRestore();
  }
}

describe("useHomeSpacePermission", () => {
  it("hands the organization catalog (`null`) to an owner", () => {
    expect(verdict(null, "owner")).toBe("yes");
    expect(verdict(null, "member")).toBe("no");
  });

  it("refuses a home that is not loaded yet (`undefined`), owner included", () => {
    // The distinction this pins: a package read always emits `home_space_id`,
    // so `undefined` means "no answer yet" and must never be read as the
    // organization catalog — that collapse handed an owner authority over a
    // package whose home they cannot even see.
    expect(verdict(undefined, "owner")).toBe("no");
  });

  it("reads the home space's own permissions when it is known", () => {
    expect(verdict("spc_home", "member")).toBe("yes");
    expect(verdict("spc_elsewhere", "owner")).toBe("no");
  });
});
