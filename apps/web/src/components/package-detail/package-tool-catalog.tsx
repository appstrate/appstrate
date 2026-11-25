// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Wrench } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Badge } from "@appstrate/ui/components/badge";
import { DataTable, type DataColumn } from "../data-table";
import { ListToolbar } from "../list-toolbar";
import { EmptyState, NoMatchState } from "../page-states";
import { CellEmpty } from "../table-cells";
import { rowActionsColumn } from "../row-actions-column";
import { useLocalListParams } from "../../lib/list-params";
import { matchesSearch } from "../../lib/strings";
import { formatDateField } from "../../lib/format-date";

export interface PackageTool {
  name: string;
  description?: string;
  permissions?: Readonly<Record<string, readonly string[]>>;
  /** What the space can do with the tool; absent for a catalog that carries no verdict. */
  status?: "available" | "missing" | "pending" | "blocked";
  /** `approved`: undeclared, validated in this space. */
  origin?: "declared" | "approved" | "listed";
  /** The listed definition changed since first seen. */
  modified?: boolean;
  /** Required scopes are unknown on an authenticated integration. */
  scopesUnknown?: boolean;
}

/** Why a tool is not usable here, as the line under its name; `null` for a usable tool. */
function useUnavailableReason(tool: PackageTool, listedAt: string | null | undefined) {
  const { t } = useTranslation("agents");
  if (tool.status === "missing") {
    return listedAt
      ? t("packageTools.reason.missingAt", { date: formatDateField(listedAt) })
      : t("packageTools.reason.missing");
  }
  if (tool.status === "pending") return t("packageTools.reason.pending");
  if (tool.status === "blocked") return t("packageTools.reason.blocked");
  return null;
}

function ToolNameCell({
  tool,
  listedAt,
  selection,
}: {
  tool: PackageTool;
  listedAt: string | null | undefined;
  selection: { values: ReadonlySet<string>; onToggle: (name: string) => void } | undefined;
}) {
  const { t } = useTranslation("agents");
  const reason = useUnavailableReason(tool, listedAt);
  const selected = selection?.values.has(tool.name) ?? false;
  return (
    <div className="flex items-start gap-2">
      {selection && (
        <Checkbox
          className="mt-0.5"
          aria-label={t("packageTools.select", { name: tool.name })}
          checked={selected}
          // A selected tool stays toggleable so the author can drop it; an unusable one cannot be added.
          disabled={reason !== null && !selected}
          onCheckedChange={() => selection.onToggle(tool.name)}
        />
      )}
      <div className={cn("flex min-w-0 flex-col gap-1", reason !== null && "opacity-60")}>
        <span className="text-foreground text-sm font-medium break-words">{tool.name}</span>
        {reason && (
          <span className="text-muted-foreground text-xs" data-testid={`tool-reason-${tool.name}`}>
            {reason}
          </span>
        )}
        {reason && selected && (
          <span className="text-warning text-xs" data-testid={`tool-warning-${tool.name}`}>
            {t("packageTools.unavailableSelected")}
          </span>
        )}
        <div className="flex flex-wrap gap-1.5 empty:hidden">
          {tool.origin === "approved" && (
            <Badge variant="secondary">{t("packageTools.approved")}</Badge>
          )}
          {tool.scopesUnknown && <Badge variant="outline">{t("packageTools.scopesUnknown")}</Badge>}
          {tool.modified && (
            <span className="text-muted-foreground text-xs italic">
              {t("packageTools.modified")}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** One tool catalog for read-only package details and optional bundle selection. */
export function PackageToolCatalog({
  tools,
  selection,
  actions,
  rowActions,
  listedAt,
}: {
  /** The list's one "Actions" menu, when the catalog is edited where it is read. */
  actions?: ReactNode;
  /** A row's "…" menu, likewise. */
  rowActions?: (tool: PackageTool) => ReactNode;
  tools: PackageTool[];
  /** When the server was last read, named by a « missing » tool's reason. */
  listedAt?: string | null;
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
      header: t("log.tool"),
      width: 160,
      elastic: true,
      cell: (tool) => <ToolNameCell tool={tool} listedAt={listedAt} selection={selection} />,
    },
    {
      id: "description",
      header: t("editor.fieldDescLabel"),
      width: 220,
      elastic: true,
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
            width: 180,
            elastic: true as const,
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
        empty={
          tools.length ? (
            <NoMatchState message={t("packageTools.noMatch")} onReset={list.reset} />
          ) : (
            <EmptyState icon={Wrench} message={t("packageTools.empty")} compact />
          )
        }
      />
    </>
  );
}
