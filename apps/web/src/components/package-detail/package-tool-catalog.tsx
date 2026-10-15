// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Wrench } from "lucide-react";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Badge } from "@appstrate/ui/components/badge";
import { DataTable, type DataColumn } from "../data-table";
import { ListToolbar } from "../list-toolbar";
import { EmptyState } from "../page-states";
import { CellEmpty } from "../table-cells";
import { rowActionsColumn } from "../row-actions-column";
import { useLocalListParams } from "../../lib/list-params";
import { matchesSearch } from "../../lib/strings";

export interface PackageTool {
  name: string;
  description?: string;
  permissions?: Readonly<Record<string, readonly string[]>>;
}

/** One tool catalog for read-only package details and optional bundle selection. */
export function PackageToolCatalog({
  tools,
  selection,
  actions,
  rowActions,
}: {
  /** The list's one "Actions" menu, when the catalog is edited where it is read. */
  actions?: ReactNode;
  /** A row's "…" menu, likewise. */
  rowActions?: (tool: PackageTool) => ReactNode;
  tools: PackageTool[];
  selection?: {
    values: ReadonlySet<string>;
    onToggle: (name: string) => void;
  };
}) {
  const { t } = useTranslation("agents");
  const authKeys = [
    ...new Set(
      tools.flatMap((tool) =>
        Object.entries(tool.permissions ?? {})
          .filter(([, scopes]) => scopes.length > 0)
          .map(([auth]) => auth),
      ),
    ),
  ];
  const list = useLocalListParams();
  const auths = list.values("auth", authKeys);
  const rows = tools.filter(
    (tool) =>
      matchesSearch(list.search, [tool.name, tool.description]) &&
      (auths.length === 0 || auths.some((key) => (tool.permissions?.[key]?.length ?? 0) > 0)),
  );
  const columns: DataColumn<PackageTool>[] = [
    {
      id: "name",
      header: t("packageTools.name"),
      width: "minmax(160px,1fr)",
      cell: (tool) => (
        <div className="flex items-start gap-2">
          {selection && (
            <Checkbox
              className="mt-0.5"
              aria-label={t("packageTools.select", { name: tool.name })}
              checked={selection.values.has(tool.name)}
              onCheckedChange={() => selection.onToggle(tool.name)}
            />
          )}
          <span className="text-foreground text-sm font-medium break-words">{tool.name}</span>
        </div>
      ),
    },
    {
      id: "description",
      header: t("packageTools.description"),
      width: "minmax(220px,2fr)",
      cell: (tool) =>
        tool.description ? (
          <span className="text-muted-foreground text-sm break-words">{tool.description}</span>
        ) : (
          <CellEmpty />
        ),
    },
    ...(authKeys.length
      ? [
          {
            id: "permissions",
            header: t("packageTools.permissions"),
            width: "minmax(180px,1fr)" as const,
            cell: (tool: PackageTool) => (
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(tool.permissions ?? {}).flatMap(([auth, scopes]) =>
                  scopes.map((scope, index) => (
                    <Badge
                      key={`${auth}:${index}:${scope}`}
                      variant="secondary"
                      className="max-w-full"
                      title={`${auth}: ${scope}`}
                    >
                      <span className="truncate">{scope}</span>
                    </Badge>
                  )),
                )}
              </div>
            ),
          },
        ]
      : []),
    ...(rowActions ? [rowActionsColumn(rowActions)] : []),
  ];

  return (
    <>
      <ListToolbar
        placement="panel"
        actions={actions}
        search={{
          value: list.search,
          onChange: list.setSearch,
          placeholder: t("packageTools.search"),
        }}
        filters={
          authKeys.length
            ? [
                {
                  id: "auth",
                  label: t("packageTools.auth"),
                  values: auths,
                  options: authKeys.map((key) => ({ value: key, label: key })),
                  onChange: list.setValues("auth"),
                },
              ]
            : []
        }
        onReset={list.reset}
      />
      <DataTable
        tableId="package-tools"
        label={t("manifest.tools")}
        columns={columns}
        rows={rows}
        rowKey={(tool) => tool.name}
        surface="integrated"
        columnMode="scroll"
        empty={
          <EmptyState
            icon={Wrench}
            message={t(tools.length ? "packageTools.noMatch" : "packageTools.empty")}
            compact
          />
        }
      />
    </>
  );
}
