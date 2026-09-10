// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PackageType } from "@appstrate/core/validation";
import { usePackageVersions, useRestoreVersion, useDeleteVersion } from "../hooks/use-packages";
import { formatDateField } from "../lib/markdown";
import { DataTable } from "./data-table";
import { ListToolbar } from "./list-toolbar";
import { EmptyState, ErrorState } from "./page-states";
import { packageDetailPath } from "../lib/package-paths";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@appstrate/ui/components/dropdown-menu";
import { ConfirmModal } from "./confirm-modal";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { Trash2, MoreHorizontal, RotateCcw, History } from "lucide-react";

interface VersionHistoryProps {
  packageId: string;
  type: PackageType;
  isOwned: boolean;
}

export function VersionHistory({ packageId, type, isOwned }: VersionHistoryProps) {
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
        label={t("version.archives")}
        rows={rows}
        rowKey={(version) => String(version.id)}
        surface="integrated"
        columnMode="scroll"
        isLoading={isLoading}
        isError={Boolean(error)}
        error={<ErrorState message={String(error)} compact />}
        empty={
          <EmptyState
            icon={History}
            message={t(search || states.length ? "version.noMatch" : "version.noVersions")}
            compact
          />
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
          ...(isOwned
            ? [
                {
                  id: "actions",
                  header: "",
                  width: "48px" as const,
                  cell: (version: NonNullable<typeof versions>[number]) => (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          aria-label={t("version.actionsFor", { version: version.version })}
                        >
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          disabled={restoreVersion.isPending || deleteVersion.isPending}
                          onSelect={() =>
                            setConfirmState({ type: "restore", version: version.version })
                          }
                        >
                          <RotateCcw />
                          {t("version.restore")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
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
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ),
                },
              ]
            : []),
        ]}
      />

      <ConfirmModal
        open={confirmState !== null}
        onClose={() => setConfirmState(null)}
        title={t("btn.confirm", { ns: "common" })}
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
