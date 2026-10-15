// SPDX-License-Identifier: Apache-2.0

import { ToneAlert } from "@/components/app-ui/status-variants";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";

export function VersionBanners({
  isHistorical,
  versionDetail,
  activeUrl,
}: {
  isHistorical: boolean;
  versionDetail: { version: string; yanked?: boolean; yanked_reason?: string | null } | undefined;
  activeUrl: string;
}) {
  const { t } = useTranslation("agents");
  if (!isHistorical || !versionDetail) return null;

  return (
    <>
      {versionDetail.yanked && (
        <ToneAlert variant="warning" className="mb-3">
          <AlertDescription>
            {t("version.yanked")}
            {versionDetail.yanked_reason ? ` — ${versionDetail.yanked_reason}` : ""}
          </AlertDescription>
        </ToneAlert>
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
