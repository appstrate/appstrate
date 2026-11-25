// SPDX-License-Identifier: Apache-2.0

import type { ReactElement } from "react";
import { QueryClient } from "@tanstack/react-query";
import { render } from "./render.tsx";
import { STUDIO_PERMISSION } from "../lib/route-access.ts";
import { spyOn } from "bun:test";
import { authStore } from "../stores/auth-store.ts";
import { orgStore } from "../stores/org-store.ts";
import { overviewStore } from "../stores/overview-store.ts";
import { spaceStore, rememberedSpaceKey } from "../stores/space-store.ts";

/** Zustand reads its initial snapshots during server rendering. Restore the spies after use. */
export function renderInSpace(
  node: ReactElement,
  {
    overview,
    queryClient,
    initialEntries,
    orgId = "org_1",
    spaceId = "spc_a",
    userId = "u_1",
  }: {
    queryClient: QueryClient;
    initialEntries?: string[];
    overview: boolean;
    orgId?: string;
    spaceId?: string | null;
    userId?: string;
  },
) {
  const mocks = [
    spyOn(orgStore, "getInitialState").mockReturnValue({
      ...orgStore.getInitialState(),
      id: orgId,
    }),
    spyOn(spaceStore, "getInitialState").mockReturnValue({
      ...spaceStore.getInitialState(),
      id: spaceId,
    }),
    spyOn(authStore, "getInitialState").mockReturnValue({
      ...authStore.getInitialState(),
      user: { id: userId, email: "u@example.test", emailVerified: true },
    }),
    spyOn(overviewStore, "getInitialState").mockReturnValue({
      ...overviewStore.getInitialState(),
      chosen: overview ? { [rememberedSpaceKey(userId, orgId)]: true } : {},
    }),
  ];
  try {
    return render(node, { queryClient, initialEntries });
  } finally {
    for (const mock of mocks) mock.mockRestore();
  }
}

const NAMES: Record<string, string> = { spc_a: "Atelier", spc_b: "Studio", spc_c: "Coffre" };

/** Every preset opens the Studio, so a fixture space does too: a test withholding it filters it out. */
export const testSpace = (id: string, permissions: string[], name = NAMES[id] ?? id) => ({
  id,
  object: "space",
  orgId: "org_1",
  access: "member",
  permissions: [STUDIO_PERMISSION, ...permissions],
  personal: false,
  isDefault: id === "spc_a",
  name,
  icon: null,
  color: null,
  role: null,
});

/** Seed the member's organization and its space list for views that read both. */
export function memberSpaceClient(spaces: readonly unknown[]) {
  const qc = new QueryClient();
  qc.setQueryData(
    ["orgs"],
    [{ id: "org_1", name: "Acme", slug: "acme", role: "member", permissions: [] }],
  );
  qc.setQueryData(["get", "/api/spaces", { params: { header: { "X-Org-Id": "org_1" } } }], {
    object: "list",
    hasMore: false,
    data: spaces,
  });
  return qc;
}
