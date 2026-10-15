// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, spyOn } from "bun:test";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { QueryClient } from "@tanstack/react-query";
import type { components } from "../../api/client.ts";
import type { DataColumn } from "../../components/data-table.tsx";
import { splitMenuActions, type MenuAction } from "../../lib/menu-action.ts";
import type { EndUserInfo } from "../../hooks/use-end-users.ts";
import { orgStore } from "../../stores/org-store.ts";
import { render } from "../../test/render.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";
import { useEndUserColumns } from "../end-user-columns.tsx";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

await i18nReady;
await i18n.changeLanguage("fr");

const endUser: EndUserInfo = {
  id: "eu_1",
  object: "end_user",
  spaceId: "spc_eu",
  name: "Ada",
  email: null,
  externalId: null,
  metadata: null,
  createdAt: "2026-09-05T00:00:00Z",
  updatedAt: "2026-09-05T00:00:00Z",
};

/** The end-user columns as a caller holding `permissions` in the organization sees them. */
function columnsFor(permissions: string[]): DataColumn<EndUserInfo>[] {
  const queryClient = new QueryClient();
  const org: components["schemas"]["Organization"] = {
    id: "org_eu",
    name: "EU",
    slug: "eu",
    logo: null,
    role: "member",
    deleting_at: null,
    permissions,
    createdAt: "2026-09-05T00:00:00Z",
  };
  queryClient.setQueryData(["orgs"], [org]);
  const orgSnapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: org.id,
  });
  let columns: DataColumn<EndUserInfo>[] = [];
  function Harness() {
    columns = useEndUserColumns({ deletingUserId: null, onEdit: () => {}, onDelete: () => {} });
    return null;
  }
  try {
    render(<Harness />, { queryClient });
  } finally {
    orgSnapshot.mockRestore();
  }
  return columns;
}

/**
 * The labels of the row menu's items. The menu is closed in a static render, so
 * they are read off the element the actions cell returns.
 */
function rowMenuLabels(columns: DataColumn<EndUserInfo>[]): string[] {
  const actions = columns.find((column) => column.id === "actions");
  if (!actions) return [];
  const menu = actions.cell(endUser) as ReactElement<{
    actions?: MenuAction[];
    children?: ReactNode;
  }>;
  const text = (node: ReactNode): string =>
    typeof node === "string"
      ? node
      : isValidElement<{ children?: ReactNode }>(node)
        ? Children.toArray(node.props.children).map(text).join("")
        : "";
  return [
    ...splitMenuActions(menu.props.actions ?? []).plain.map((action) => action.label),
    ...Children.toArray(menu.props.children).map(text),
    ...splitMenuActions(menu.props.actions ?? []).destructive.map((action) => action.label),
  ].filter((label) => label !== "");
}

describe("the end-user row menu", () => {
  it("is absent for a reader", () => {
    const columns = columnsFor(["end-users:read"]);
    expect(columns.map((column) => column.id)).not.toContain("actions");
  });

  it("offers Modifier, and only that, to a writer", () => {
    expect(rowMenuLabels(columnsFor(["end-users:read", "end-users:write"]))).toEqual(["Modifier"]);
  });

  it("offers Supprimer, and only that, to a caller who may delete but not edit", () => {
    expect(rowMenuLabels(columnsFor(["end-users:read", "end-users:delete"]))).toEqual([
      "Supprimer",
    ]);
  });

  it("offers both to a caller holding both", () => {
    expect(
      rowMenuLabels(columnsFor(["end-users:read", "end-users:write", "end-users:delete"])),
    ).toEqual(["Modifier", "Supprimer"]);
  });
});
