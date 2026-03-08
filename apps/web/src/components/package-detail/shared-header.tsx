import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { VersionSelector } from "../version-selector";

interface SharedHeaderDetail {
  id: string;
  displayName: string;
  description: string;
  source: string;
  type: "flow" | "skill" | "extension" | "provider";
  version?: string | null;
  versionCount?: number;
  hasUnpublishedChanges?: boolean;
}

export function SharedHeader({
  detail,
  packageId,
  versionParam,
  hasDraftChanges,
  isHistoricalVersion,
  actionsLeft,
  actionsRight,
}: {
  detail: SharedHeaderDetail;
  packageId: string;
  versionParam: string | undefined;
  hasDraftChanges: boolean;
  isHistoricalVersion: boolean;
  actionsLeft?: React.ReactNode;
  actionsRight?: React.ReactNode;
}) {
  const { t } = useTranslation(["flows", "settings", "common"]);

  const breadcrumbPath = detail.type === "flow" ? "/" : `/#${detail.type}s`;
  const breadcrumbLabel =
    detail.type === "flow"
      ? t("detail.breadcrumb")
      : t(`packages.type.${detail.type}s`, { ns: "settings" });

  const hasActions = actionsLeft || actionsRight;
  const hasVersionSelector = detail.versionCount != null && detail.versionCount > 0;

  return (
    <>
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground mb-4">
        <Link to={breadcrumbPath} className="text-muted-foreground hover:text-foreground">
          {breadcrumbLabel}
        </Link>
        <span className="opacity-50">/</span>
        <span>{detail.displayName}</span>
      </nav>

      <div className="mb-4">
        <div className="flex items-center flex-wrap gap-2">
          <h2 className="text-xl font-semibold">{detail.displayName}</h2>
          <div className="flex items-center gap-1.5">
            {detail.source === "system" && (
              <span className="text-[0.65rem] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium uppercase">
                {t("packages.sourceBuiltIn", { ns: "settings" })}
              </span>
            )}
            {isHistoricalVersion && (
              <span className="text-[0.65rem] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">
                {t("version.readOnly")}
              </span>
            )}
          </div>
        </div>
        <code className="text-xs text-muted-foreground mt-1 block">{detail.id}</code>
        {detail.description && (
          <p className="text-sm text-muted-foreground mt-1">{detail.description}</p>
        )}
        {(hasActions || hasVersionSelector) && (
          <div className="flex items-center gap-2 mt-3">
            {actionsLeft}
            <div className="ml-auto flex items-center gap-2">
              {hasVersionSelector && (
                <VersionSelector
                  packageId={packageId}
                  currentVersion={versionParam}
                  type={detail.type}
                  hasDraftChanges={hasDraftChanges}
                  currentIsDraft={!versionParam && hasDraftChanges}
                />
              )}
              {actionsRight}
            </div>
          </div>
        )}
      </div>

      <div className="w-full h-px border-b border-border border-dashed my-6"></div>
    </>
  );
}
