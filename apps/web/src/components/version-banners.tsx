import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function VersionBanners({
  isHistorical,
  versionDetail,
}: {
  isHistorical: boolean;
  versionDetail: { version: string; yanked?: boolean; yankedReason?: string | null } | undefined;
}) {
  const { t } = useTranslation("flows");
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
          {t("version.viewing", { version: versionDetail.version })}
        </AlertDescription>
      </Alert>
    </>
  );
}
