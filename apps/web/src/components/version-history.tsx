import { useTranslation } from "react-i18next";
import { usePackageVersions, useRestoreVersion } from "../hooks/use-packages";
import { formatDateField } from "../lib/markdown";
import { Spinner } from "./spinner";

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
    return <p className="detail-empty">{t("version.noVersions")}</p>;
  }

  return (
    <div className="version-history">
      {versions.map((v) => (
        <div key={v.id} className="version-history-row">
          <span className="version-label">{v.version}</span>
          <span className="version-date">{v.createdAt ? formatDateField(v.createdAt) : ""}</span>
          {v.yanked && <span className="version-yanked-badge">{t("version.yanked")}</span>}
          {isAdmin && (
            <button
              type="button"
              onClick={() => {
                if (confirm(t("version.restoreConfirm", { version: v.version }))) {
                  restoreVersion.mutate(v.version);
                }
              }}
              disabled={restoreVersion.isPending}
            >
              {restoreVersion.isPending && <Spinner />} {t("version.restore")}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
