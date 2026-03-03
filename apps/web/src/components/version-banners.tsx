import { useTranslation } from "react-i18next";

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
        <div className="version-banner warning">
          {t("version.yanked")}
          {versionDetail.yankedReason ? ` — ${versionDetail.yankedReason}` : ""}
        </div>
      )}
      <div className="version-banner info">
        {t("version.viewing", { version: versionDetail.version })}
      </div>
    </>
  );
}
