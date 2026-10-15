// SPDX-License-Identifier: Apache-2.0

import { ToneBadge } from "@/components/app-ui/status-variants";
import { Link } from "react-router-dom";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PackageType } from "@appstrate/core/validation";
import { usePackageVersions, useRestoreVersion, useDeleteVersion } from "../hooks/use-packages";
import { DataTable } from "./data-table";
import { ListToolbar } from "./list-toolbar";
import { EmptyState, EmptyStateAction } from "./page-states";
import { packageDetailPath } from "../lib/package-paths";
import { useLocalListParams } from "../lib/list-params";
import { matchesSearch } from "../lib/strings";
import { TableRowActions } from "./table-row-actions";
import { rowActionsColumn } from "./row-actions-column";
import { CellDate } from "./table-cells";
import { ConfirmModal } from "./confirm-modal";
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
  const list = useLocalListParams();
  const { search } = list;
  const states = list.values("status", ["published", "yanked"] as const);
  const restoreVersion = useRestoreVersion(type, packageId);
  const deleteVersion = useDeleteVersion(type, packageId);
  const [confirmState, setConfirmState] = useState<{
    type: "restore" | "delete";
    version: string;
  } | null>(null);

  const rows = (versions ?? []).filter(
    (version) =>
      matchesSearch(search, [version.version]) &&
      (states.length === 0 || states.includes(version.yanked ? "yanked" : "published")),
  );

  return (
    <>
      <ListToolbar
        placement="panel"
        search={{ value: search, onChange: list.setSearch, placeholder: t("version.search") }}
        filters={[
          {
            id: "status",
            label: t("version.status"),
            values: states,
            options: [
              { value: "published", label: t("version.published") },
              { value: "yanked", label: t("version.yanked") },
            ],
            onChange: list.setValues("status"),
          },
        ]}
        onReset={list.reset}
      />
      <DataTable
        tableId="versions"
        label={t("version.history")}
        rows={rows}
        rowKey={(version) => String(version.id)}
        surface="integrated"
        columnMode="scroll"
        isLoading={isLoading}
        failure={error}
        empty={
          <EmptyState
            icon={History}
            message={t(search || states.length ? "version.noMatch" : "version.noVersions")}
            compact
          >
            {onCreate && !search && !states.length && (
              <EmptyStateAction
                action={{ label: t("version.createVersion"), onSelect: onCreate }}
              />
            )}
          </EmptyState>
        }
        columns={[
          {
            id: "version",
            header: t("version.version"),
            width: "minmax(80px,1fr)",
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
            width: "minmax(120px,1fr)",
            align: "end",
            cell: (version) => <CellDate value={version.createdAt} />,
          },
          {
            id: "status",
            header: t("version.status"),
            width: "minmax(100px,1fr)",
            cell: (version) => (
              <ToneBadge variant={version.yanked ? "warning" : "secondary"}>
                {t(version.yanked ? "version.yanked" : "version.published")}
              </ToneBadge>
            ),
          },
          ...(onCompare || canRestore || canDelete
            ? [
                rowActionsColumn((version: NonNullable<typeof versions>[number]) => (
                  <TableRowActions
                    menuLabel={t("version.actionsFor", { version: version.version })}
                    actions={[
                      {
                        id: "compare",
                        label: t("version.compareWithDraft"),
                        icon: GitCompareArrows,
                        onSelect: () => onCompare?.(version.version),
                        hidden: !onCompare,
                      },
                      {
                        id: "restore",
                        label: t("version.restore"),
                        icon: RotateCcw,
                        disabled: restoreVersion.isPending || deleteVersion.isPending,
                        onSelect: () =>
                          setConfirmState({ type: "restore", version: version.version }),
                        hidden: !canRestore,
                      },
                      {
                        id: "delete",
                        label: t("btn.delete", { ns: "common" }),
                        icon: Trash2,
                        destructive: true,
                        disabled: deleteVersion.isPending || restoreVersion.isPending,
                        onSelect: () =>
                          setConfirmState({ type: "delete", version: version.version }),
                        hidden: !canDelete,
                      },
                    ]}
                  />
                )),
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
