import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import type { PackageType } from "@appstrate/shared-types";
import { VersionSelector } from "../version-selector";
import { packageListPath } from "../../lib/package-paths";
import { InlineMarkdown } from "../markdown";
import { PageHeader } from "../page-header";

interface SharedHeaderDetail {
  id: string;
  displayName: string;
  description: string;
  source: string;
  type: PackageType;
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

  const breadcrumbPath = packageListPath(detail.type);
  const breadcrumbLabel =
    detail.type === "flow"
      ? t("detail.breadcrumb")
      : t(`packages.type.${detail.type}s`, { ns: "settings" });

  const hasActions = actionsLeft || actionsRight;
  const hasVersionSelector = detail.versionCount != null && detail.versionCount > 0;

  return (
    <>
      <PageHeader
        title={detail.displayName}
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: breadcrumbLabel, href: breadcrumbPath },
          { label: detail.displayName },
        ]}
        actions={
          <>
            {detail.source === "system" && (
              <span title={t("packages.sourceBuiltIn", { ns: "settings" })}>
                <ShieldCheck className="h-4 w-4 text-muted-foreground" />
              </span>
            )}
            {isHistoricalVersion && (
              <span className="text-[0.65rem] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">
                {t("version.readOnly")}
              </span>
            )}
          </>
        }
      >
        <code className="text-xs text-muted-foreground mt-1 block">{detail.id}</code>
        {detail.description && (
          <p className="text-sm text-muted-foreground mt-1">
            <InlineMarkdown>{detail.description}</InlineMarkdown>
          </p>
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
      </PageHeader>

      <div className="w-full h-px border-b border-border border-dashed my-6"></div>
    </>
  );
}
