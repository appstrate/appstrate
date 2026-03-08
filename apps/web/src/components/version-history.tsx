import { useTranslation } from "react-i18next";
import { usePackageVersions, useRestoreVersion, useDeleteVersion } from "../hooks/use-packages";
import { formatDateField } from "../lib/markdown";
import { Spinner } from "./spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";

interface VersionHistoryProps {
  packageId: string;
  type: "flow" | "skill" | "extension" | "provider";
  isAdmin: boolean;
  isOwned: boolean;
}

export function VersionHistory({ packageId, type, isAdmin, isOwned }: VersionHistoryProps) {
  const { t } = useTranslation("flows");
  const { data: versions } = usePackageVersions(type, packageId);
  const restoreVersion = useRestoreVersion(type, packageId);
  const deleteVersion = useDeleteVersion(type, packageId);

  if (!versions || versions.length === 0) {
    return <p className="text-muted-foreground text-sm">{t("version.noVersions")}</p>;
  }

  return (
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
                onClick={() => {
                  if (confirm(t("version.restoreConfirm", { version: v.version }))) {
                    restoreVersion.mutate(v.version);
                  }
                }}
                disabled={restoreVersion.isPending || deleteVersion.isPending}
              >
                {restoreVersion.isPending && <Spinner />} {t("version.restore")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => {
                  if (confirm(t("version.deleteConfirm", { version: v.version }))) {
                    deleteVersion.mutate(v.version);
                  }
                }}
                disabled={deleteVersion.isPending || restoreVersion.isPending}
              >
                {deleteVersion.isPending ? <Spinner /> : <Trash2 className="h-3.5 w-3.5" />}
              </Button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
