import { useTranslation } from "react-i18next";
import { usePackageVersions, useRestoreVersion } from "../hooks/use-packages";
import { formatDateField } from "../lib/markdown";
import { Spinner } from "./spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface VersionHistoryProps {
  packageId: string;
  type: "flow" | "skill" | "extension";
  isAdmin: boolean;
}

export function VersionHistory({ packageId, type, isAdmin }: VersionHistoryProps) {
  const { t } = useTranslation("flows");
  const { data: versions } = usePackageVersions(type, packageId);
  const restoreVersion = useRestoreVersion(type, packageId);

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
          {isAdmin && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (confirm(t("version.restoreConfirm", { version: v.version }))) {
                  restoreVersion.mutate(v.version);
                }
              }}
              disabled={restoreVersion.isPending}
            >
              {restoreVersion.isPending && <Spinner />} {t("version.restore")}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
