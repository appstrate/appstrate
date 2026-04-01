import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PackageType } from "@appstrate/shared-types";
import { usePackageVersions, useRestoreVersion, useDeleteVersion } from "../hooks/use-packages";
import { formatDateField } from "../lib/markdown";
import { Spinner } from "./spinner";
import { ConfirmModal } from "./confirm-modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";

interface VersionHistoryProps {
  packageId: string;
  type: PackageType;
  isAdmin: boolean;
  isOwned: boolean;
}

export function VersionHistory({ packageId, type, isAdmin, isOwned }: VersionHistoryProps) {
  const { t } = useTranslation("flows");
  const { data: versions } = usePackageVersions(type, packageId);
  const restoreVersion = useRestoreVersion(type, packageId);
  const deleteVersion = useDeleteVersion(type, packageId);
  const [confirmState, setConfirmState] = useState<{
    type: "restore" | "delete";
    version: string;
  } | null>(null);

  if (!versions || versions.length === 0) {
    return <p className="text-muted-foreground text-sm">{t("version.noVersions")}</p>;
  }

  return (
    <>
      <div className="space-y-1">
        {versions.map((v) => (
          <div key={v.id} className="flex items-center gap-3 rounded-md px-3 py-2 text-sm">
            <span className="font-mono font-medium">{v.version}</span>
            <span className="text-muted-foreground text-xs">
              {v.createdAt ? formatDateField(v.createdAt) : ""}
            </span>
            {v.yanked && <Badge variant="warning">{t("version.yanked")}</Badge>}
            {isAdmin && isOwned && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmState({ type: "restore", version: v.version })}
                  disabled={restoreVersion.isPending || deleteVersion.isPending}
                >
                  {restoreVersion.isPending && <Spinner />} {t("version.restore")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => setConfirmState({ type: "delete", version: v.version })}
                  disabled={deleteVersion.isPending || restoreVersion.isPending}
                >
                  {deleteVersion.isPending ? <Spinner /> : <Trash2 className="h-3.5 w-3.5" />}
                </Button>
              </>
            )}
          </div>
        ))}
      </div>

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
