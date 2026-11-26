// SPDX-License-Identifier: Apache-2.0

import type { QueryClient } from "@tanstack/react-query";

/** The organization and role catalogue the personal-space-role screens read. */
export const ORG_ID = "org_a";
export const CUSTOM_ROLE_ID = "srl_triage";

const ROLE_CATALOG = [
  { id: null, kind: "preset", key: "admin", name: "admin", permissions: ["agents:write"] },
  { id: null, kind: "preset", key: "operator", name: "operator", permissions: ["agents:run"] },
  { id: CUSTOM_ROLE_ID, kind: "custom", key: "triage", name: "Triage", permissions: [] },
] as const;

/** Seeds the caller's organization (with `permissions`) and the role catalogue. */
export function seedOrgAndRoles(queryClient: QueryClient, permissions: string[]): void {
  queryClient.setQueryData(
    ["orgs"],
    [
      {
        id: ORG_ID,
        name: "Acme",
        slug: "acme",
        role: "admin",
        permissions,
        createdAt: "2026-07-01T10:00:00.000Z",
      },
    ],
  );
  queryClient.setQueryData(["get", "/api/roles", { params: { header: { "X-Org-Id": ORG_ID } } }], {
    data: ROLE_CATALOG,
  });
}
