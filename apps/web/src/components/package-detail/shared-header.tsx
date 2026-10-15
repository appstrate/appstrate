// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import type { PackageType } from "@appstrate/core/validation";
import { Badge } from "@appstrate/ui/components/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { packageDetailPath } from "../../lib/package-paths";
import { InlineMarkdown } from "../markdown";
import { PageHeader } from "../page-header";
import { usePackageListCrumb } from "../../hooks/use-package-list-crumb";
import { PackageIcon } from "../package-icon";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { versionBadges } from "./version-badge";

interface SharedHeaderDetail {
  id: string;
  displayName: string;
  description: string;
  source: string;
  type: PackageType;
  version?: string | null;
  /**
   * The page shows the latest PUBLISHED version, not the draft: what a caller
   * who may not write the package reads (`definition: "published"`).
   */
  readsPublished?: boolean;
  /** AFPS icon token for agents, raw image URL or Iconify id for integrations. */
  icon?: string;
  /** Appstrate Agent presentation colour token. */
  color?: string;
  /**
   * Name of the space this package lives in — the one whose permissions decide
   * who may edit it. Absent for the org catalog and for a home the reader
   * cannot enter.
   */
  homeSpaceName?: string | null;
}

export function SharedHeader({
  detail,
  isHistoricalVersion,
  hasUnarchivedChanges,
  draftVerdictPending,
  latestPublishedVersion,
  activeSubpage,
  actionsLeft,
  actionsRight,
}: {
  detail: SharedHeaderDetail;
  isHistoricalVersion: boolean;
  hasUnarchivedChanges?: boolean;
  /** The draft-vs-published comparison is still being read: the badge holds its place. */
  draftVerdictPending?: boolean;
  latestPublishedVersion?: string | null;
  activeSubpage?: { label: string };
  actionsLeft?: React.ReactNode;
  actionsRight?: React.ReactNode;
}) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  const listCrumb = usePackageListCrumb(detail.type);

  const badges = versionBadges({
    ...detail,
    isHistoricalVersion,
    hasUnarchivedChanges,
    draftVerdictPending,
  });
  const iconNode = <PackageIcon type={detail.type} icon={detail.icon} color={detail.color} />;

  return (
    <>
      <PageHeader
        title={detail.displayName}
        titleClassName="text-xl"
        icon={iconNode}
        wrapActions
        breadcrumbs={[
          listCrumb,
          {
            label: detail.displayName,
            href: activeSubpage ? packageDetailPath(detail.type, detail.id) : undefined,
          },
          ...(activeSubpage ? [activeSubpage] : []),
        ]}
        actions={
          <>
            {detail.type !== "agent" && detail.source === "system" && (
              <Badge variant="secondary" className="gap-1.5">
                <ShieldCheck className="size-3" aria-hidden />
                {t("providers.type.system", { ns: "settings" })}
              </Badge>
            )}
            {/* Where the package LIVES, which is where it may be edited. A
                badge like the ones beside it rather than a bare span: the
                header speaks one vocabulary. */}
            {detail.homeSpaceName && (
              <Badge variant="secondary">
                {t("packages.homeSpace", { ns: "settings", space: detail.homeSpaceName })}
              </Badge>
            )}
            {detail.type === "agent" && detail.source === "system" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>
                    <Badge variant="secondary" className="gap-1.5">
                      <ShieldCheck className="size-3" aria-hidden />
                      <span className="hidden sm:inline">{t("ownership.systemAgent")}</span>
                    </Badge>
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-80">
                  {t("ownership.systemAgentTooltip")}
                </TooltipContent>
              </Tooltip>
            )}
            {badges.map((badge) => {
              switch (badge.kind) {
                case "version":
                  return (
                    <Badge key="version" variant="secondary" className="font-mono">
                      v{badge.version}
                    </Badge>
                  );
                case "modified":
                  return (
                    <Badge key="modified" variant="warning">
                      {t("version.modified")}
                    </Badge>
                  );
                case "readOnly":
                  return (
                    <Badge key="readOnly" variant="secondary">
                      {t("version.readOnly")}
                    </Badge>
                  );
                case "readOnlyVersion":
                  return (
                    <Badge key="readOnly" variant="secondary" className="font-mono">
                      v{badge.version} · <span className="font-sans">{t("version.readOnly")}</span>
                    </Badge>
                  );
                case "draftPending":
                  return <Skeleton key="draft" className="h-5 w-14" />;
                case "draft":
                  return (
                    <Tooltip key="draft">
                      <TooltipTrigger asChild>
                        <span tabIndex={0}>
                          <Badge variant="secondary">{t("version.draft")}</Badge>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-80">
                        {latestPublishedVersion
                          ? t("version.draftTooltip", { version: latestPublishedVersion })
                          : t("version.draftTooltipNoVersion")}
                      </TooltipContent>
                    </Tooltip>
                  );
              }
            })}
            {actionsLeft}
            {actionsRight}
          </>
        }
      >
        <code className="text-muted-foreground mt-1 block text-xs">{detail.id}</code>
        {detail.description && (
          <p className="text-muted-foreground mt-1 text-sm">
            <InlineMarkdown>{detail.description}</InlineMarkdown>
          </p>
        )}
      </PageHeader>
    </>
  );
}
