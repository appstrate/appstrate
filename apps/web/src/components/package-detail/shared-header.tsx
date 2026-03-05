import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { TypeBadge } from "../type-badge";
import { VersionSelector } from "../version-selector";

interface SharedHeaderDetail {
  id: string;
  displayName: string;
  description: string;
  source: string;
  type: "flow" | "skill" | "extension";
  version?: string | null;
  versionCount?: number;
  hasUnpublishedChanges?: boolean;
}

export function SharedHeader({
  detail,
  packageId,
  versionParam,
  hasDraftChanges,
  isVersionView,
  isHistoricalVersion,
  headerExtras,
}: {
  detail: SharedHeaderDetail;
  packageId: string;
  versionParam: string | undefined;
  hasDraftChanges: boolean;
  isVersionView: boolean;
  isHistoricalVersion: boolean;
  headerExtras?: React.ReactNode;
}) {
  const { t } = useTranslation(["flows", "settings", "common"]);

  const breadcrumbPath = detail.type === "flow" ? "/" : `/?tab=${detail.type}s`;
  const breadcrumbLabel =
    detail.type === "flow"
      ? t("detail.breadcrumb")
      : t(`packages.type.${detail.type}s`, { ns: "settings" });

  return (
    <>
      <nav className="breadcrumb">
        <Link to={breadcrumbPath}>{breadcrumbLabel}</Link>
        <span className="separator">/</span>
        <span className="current">{detail.displayName}</span>
      </nav>

      <div className="flow-detail-header">
        <div className="header-row">
          <h2>{detail.displayName}</h2>
          <div className="flow-card-badges">
            {detail.type !== "flow" && <TypeBadge type={detail.type} />}
            {detail.source === "built-in" && (
              <span className="source-badge">
                {t("packages.sourceBuiltIn", { ns: "settings" })}
              </span>
            )}
            {hasDraftChanges && !isVersionView && (
              <span className="version-badge unpublished">{t("version.unpublished")}</span>
            )}
            {isHistoricalVersion && (
              <span className="version-readonly-badge">{t("version.readOnly")}</span>
            )}
          </div>
          <div className="header-selectors">
            {detail.versionCount && detail.versionCount > 0 && (
              <VersionSelector
                packageId={packageId}
                currentVersion={versionParam}
                type={detail.type}
                hasDraftChanges={hasDraftChanges}
                currentIsDraft={!versionParam}
              />
            )}
            {headerExtras}
          </div>
        </div>
        {detail.description && <p className="description">{detail.description}</p>}
        {detail.type !== "flow" && <code className="detail-id">{detail.id}</code>}
      </div>
    </>
  );
}
