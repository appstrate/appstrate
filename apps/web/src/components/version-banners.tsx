// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function VersionBanners({
  isHistorical,
  versionDetail,
  hasDraftChanges,
  latestUrl,
  latestVersion,
}: {
  isHistorical: boolean;
  versionDetail: { version: string; yanked?: boolean; yankedReason?: string | null } | undefined;
  hasDraftChanges: boolean;
  latestUrl: string;
  latestVersion?: string | null;
}) {
  const { t } = useTranslation("agents");
  if (!isHistorical || !versionDetail) return null;

  const linkLabel = hasDraftChanges
    ? t("version.goToDraft")
    : t("version.goToLatest", { latest: latestVersion ?? "—" });

  return (
    <>
      {versionDetail.yanked && (
        <Alert variant="warning" className="mb-3">
          <AlertDescription>
            {t("version.yanked")}
            {versionDetail.yankedReason ? ` — ${versionDetail.yankedReason}` : ""}
          </AlertDescription>
        </Alert>
      )}
      <Alert className="mb-3">
        <AlertDescription>
          {t("version.viewingHistorical", { version: versionDetail.version })}{" "}
          <Link to={latestUrl} className="font-medium underline">
            {linkLabel}
          </Link>
        </AlertDescription>
      </Alert>
    </>
  );
}
