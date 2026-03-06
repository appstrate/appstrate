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

  const breadcrumbPath = detail.type === "flow" ? "/" : `/#${detail.type}s`;
  const breadcrumbLabel =
    detail.type === "flow"
      ? t("detail.breadcrumb")
      : t(`packages.type.${detail.type}s`, { ns: "settings" });

  return (
    <>
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground mb-4">
        <Link to={breadcrumbPath} className="text-muted-foreground hover:text-foreground">
          {breadcrumbLabel}
        </Link>
        <span className="opacity-50">/</span>
        <span>{detail.displayName}</span>
      </nav>

      <div className="mb-6">
        <div className="flex items-center flex-wrap gap-2">
          <h2 className="text-xl font-semibold">{detail.displayName}</h2>
          <div className="flex items-center gap-1.5">
            {detail.type !== "flow" && <TypeBadge type={detail.type} />}
            {detail.source === "built-in" && (
              <span className="text-[0.65rem] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium uppercase">
                {t("packages.sourceBuiltIn", { ns: "settings" })}
              </span>
            )}
            {hasDraftChanges && !isVersionView && (
              <span className="text-[0.65rem] px-1.5 py-0.5 rounded bg-warning/15 text-warning font-medium">
                {t("version.unpublished")}
              </span>
            )}
            {isHistoricalVersion && (
              <span className="text-[0.65rem] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">
                {t("version.readOnly")}
              </span>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {detail.versionCount != null && detail.versionCount > 0 && (
              <VersionSelector
                packageId={packageId}
                currentVersion={versionParam}
                type={detail.type}
                hasDraftChanges={hasDraftChanges}
                currentIsDraft={!versionParam && hasDraftChanges}
              />
            )}
            {headerExtras}
          </div>
        </div>
        {detail.description && (
          <p className="text-sm text-muted-foreground mt-1">{detail.description}</p>
        )}
        {detail.type !== "flow" && (
          <code className="text-xs text-muted-foreground mt-1 block">{detail.id}</code>
        )}
      </div>
    </>
  );
}
