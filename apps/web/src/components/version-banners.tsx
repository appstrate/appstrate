// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function VersionBanners({
  isHistorical,
  versionDetail,
  activeUrl,
}: {
  isHistorical: boolean;
  versionDetail: { version: string; yanked?: boolean; yankedReason?: string | null } | undefined;
  activeUrl: string;
}) {
  const { t } = useTranslation("agents");
  if (!isHistorical || !versionDetail) return null;

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
          {t("version.viewingArchive", { version: versionDetail.version })}{" "}
          <Link to={activeUrl} className="font-medium underline">
            {t("version.goToActive")}
          </Link>
        </AlertDescription>
      </Alert>
    </>
  );
}
