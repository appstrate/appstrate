// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PackageType } from "@appstrate/core/validation";
import { usePackageVersions, useRestoreVersion, useDeleteVersion } from "../hooks/use-packages";
import { formatDateField } from "../lib/format-date";
import { DataTable } from "./data-table";
import { ListToolbar } from "./list-toolbar";
import { EmptyState, EmptyStateAction, ErrorState } from "./page-states";
import { packageDetailPath } from "../lib/package-paths";
import { DropdownMenuItem, DropdownMenuSeparator } from "@appstrate/ui/components/dropdown-menu";
import { TableRowActions } from "./table-row-actions";
import { ConfirmModal } from "./confirm-modal";
import { Badge } from "@appstrate/ui/components/badge";
import { Trash2, RotateCcw, History, GitCompareArrows } from "lucide-react";

interface VersionHistoryProps {
  packageId: string;
  type: PackageType;
  /**
   * Restoring writes the draft, deleting removes a version: both are judged in
   * the package's HOME space (`home_writable` / `home_deletable`), never in the
   * space being browsed.
   */
  canRestore: boolean;
  canDelete: boolean;
  /** Compare that version with the current draft, in the section's own modal. */
  onCompare?: (version: string) => void;
  /** Present when the caller may create a version: the same act as the page's Actions menu. */
  onCreate?: () => void;
}

export function VersionHistory({
  packageId,
  type,
  canRestore,
  canDelete,
  onCompare,
  onCreate,
}: VersionHistoryProps) {
  const { t } = useTranslation(["agents", "common"]);
  const { data: versions, isLoading, error } = usePackageVersions(type, packageId);
  const [search, setSearch] = useState("");
  const [states, setStates] = useState<string[]>([]);
  const restoreVersion = useRestoreVersion(type, packageId);
  const deleteVersion = useDeleteVersion(type, packageId);
  const [confirmState, setConfirmState] = useState<{
    type: "restore" | "delete";
    version: string;
  } | null>(null);

  const rows = (versions ?? []).filter(
    (version) =>
      version.version.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) &&
      (states.length === 0 || states.includes(version.yanked ? "yanked" : "published")),
  );

  return (
    <>
      <ListToolbar
        placement="panel"
        panelFiltersAdjacent
        search={{ value: search, onChange: setSearch, placeholder: t("version.search") }}
        filters={[
          {
            id: "status",
            label: t("runs.filterStatus"),
            values: states,
            options: [
              { value: "published", label: t("version.published") },
              { value: "yanked", label: t("version.yanked") },
            ],
            onChange: setStates,
          },
        ]}
        onReset={() => {
          setSearch("");
          setStates([]);
        }}
      />
      <DataTable
        label={t("version.history")}
        rows={rows}
        rowKey={(version) => String(version.id)}
        surface="integrated"
        columnMode="scroll"
        isLoading={isLoading}
        isError={Boolean(error)}
        error={<ErrorState error={error} compact />}
        empty={
          <EmptyState
            icon={History}
            message={t(search || states.length ? "version.noMatch" : "version.noVersions")}
            compact
          >
            {onCreate && !search && !states.length && (
              <EmptyStateAction label={t("version.createVersion")} onClick={onCreate} />
            )}
          </EmptyState>
        }
        columns={[
          {
            id: "version",
            header: t("run.infoVersion"),
            width: "minmax(120px,1fr)",
            cell: (version) =>
              type === "integration" ? (
                <span className="font-mono text-sm">{version.version}</span>
              ) : (
                <Link
                  className="text-primary font-mono text-sm hover:underline"
                  to={`${packageDetailPath(type, packageId)}/${version.version}`}
                >
                  {version.version}
                </Link>
              ),
          },
          {
            id: "date",
            header: t("version.created"),
            width: "minmax(180px,1fr)",
            cell: (version) => (version.createdAt ? formatDateField(version.createdAt) : "–"),
          },
          {
            id: "status",
            header: t("runs.filterStatus"),
            width: "minmax(160px,1fr)",
            cell: (version) => (
              <Badge variant={version.yanked ? "warning" : "secondary"}>
                {t(version.yanked ? "version.yanked" : "version.published")}
              </Badge>
            ),
          },
          ...(onCompare || canRestore || canDelete
            ? [
                {
                  id: "actions",
                  header: "",
                  width: "48px" as const,
                  cell: (version: NonNullable<typeof versions>[number]) => (
                    <TableRowActions
                      menuLabel={t("version.actionsFor", { version: version.version })}
                    >
                      {onCompare && (
                        <DropdownMenuItem onSelect={() => onCompare(version.version)}>
                          <GitCompareArrows />
                          {t("version.compareWithDraft")}
                        </DropdownMenuItem>
                      )}
                      {canRestore && (
                        <DropdownMenuItem
                          disabled={restoreVersion.isPending || deleteVersion.isPending}
                          onSelect={() =>
                            setConfirmState({ type: "restore", version: version.version })
                          }
                        >
                          <RotateCcw />
                          {t("version.restore")}
                        </DropdownMenuItem>
                      )}
                      {canDelete && (
                        <>
                          {(onCompare || canRestore) && <DropdownMenuSeparator />}
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            disabled={deleteVersion.isPending || restoreVersion.isPending}
                            onSelect={() =>
                              setConfirmState({ type: "delete", version: version.version })
                            }
                          >
                            <Trash2 />
                            {t("btn.delete", { ns: "common" })}
                          </DropdownMenuItem>
                        </>
                      )}
                    </TableRowActions>
                  ),
                },
              ]
            : []),
        ]}
      />

      <ConfirmModal
        open={confirmState !== null}
        onClose={() => setConfirmState(null)}
        title={
          confirmState?.type === "restore" ? t("version.restoreTitle") : t("version.deleteTitle")
        }
        confirmLabel={
          confirmState?.type === "restore"
            ? t("version.restore")
            : t("btn.delete", { ns: "common" })
        }
        description={
          confirmState?.type === "restore"
            ? t("version.restoreConfirm", { version: confirmState.version })
            : t("version.deleteConfirm", { version: confirmState?.version })
        }
        variant={confirmState?.type === "restore" ? "default" : "destructive"}
        isPending={restoreVersion.isPending || deleteVersion.isPending}
        onConfirm={() => {
          if (!confirmState) return;
          if (confirmState.type === "restore") {
            restoreVersion.mutate(confirmState.version, {
              onSuccess: () => setConfirmState(null),
            });
          } else {
            deleteVersion.mutate(confirmState.version, {
              onSuccess: () => setConfirmState(null),
            });
          }
        }}
      />
    </>
  );
}
