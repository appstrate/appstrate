// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import type { PackageType } from "@appstrate/core/validation";
import { Badge } from "@appstrate/ui/components/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { packageDetailPath, packageListPath } from "../../lib/package-paths";
import { InlineMarkdown } from "../markdown";
import { PageHeader } from "../page-header";
import { PackageIcon } from "../package-icon";

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
  latestPublishedVersion,
  activeSubpage,
  statusBadges,
  actionsLeft,
  actionsRight,
}: {
  detail: SharedHeaderDetail;
  isHistoricalVersion: boolean;
  hasUnarchivedChanges?: boolean;
  latestPublishedVersion?: string | null;
  activeSubpage?: { label: string };
  statusBadges?: React.ReactNode;
  actionsLeft?: React.ReactNode;
  actionsRight?: React.ReactNode;
}) {
  const { t } = useTranslation(["agents", "settings", "common"]);

  const breadcrumbPath = packageListPath(detail.type);
  const breadcrumbLabel =
    detail.type === "agent"
      ? t("detail.breadcrumb")
      : t(`packages.type.${detail.type}s`, { ns: "settings" });

  const iconNode = (
    <PackageIcon type={detail.type} id={detail.id} icon={detail.icon} color={detail.color} />
  );

  return (
    <>
      <PageHeader
        title={detail.displayName}
        titleClassName="text-xl"
        icon={iconNode}
        wrapActions
        breadcrumbs={[
          { label: breadcrumbLabel, href: breadcrumbPath },
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
                {t("packages.sourceBuiltIn", { ns: "settings" })}
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
            {detail.type !== "agent" && detail.version && (
              <Badge variant="secondary" className="font-mono">
                v{detail.version}
              </Badge>
            )}
            {detail.type !== "agent" && hasUnarchivedChanges && !isHistoricalVersion && (
              <Badge variant="warning">{t("version.modified")}</Badge>
            )}
            {detail.type !== "agent" && isHistoricalVersion && (
              <Badge variant="secondary">{t("version.readOnly")}</Badge>
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
            {detail.type === "agent" && detail.readsPublished && !isHistoricalVersion && (
              <Badge variant="secondary" className="font-mono">
                v{detail.version}
              </Badge>
            )}
            {/* A draft that says what the last published version already says is not worth a
                badge of its own: the version is. "Draft" means it differs, or nothing is published. */}
            {detail.type === "agent" &&
              detail.source !== "system" &&
              !detail.readsPublished &&
              !isHistoricalVersion &&
              (hasUnarchivedChanges || !detail.version ? (
                <Tooltip>
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
              ) : (
                <Badge variant="secondary" className="font-mono">
                  v{detail.version}
                </Badge>
              ))}
            {detail.type === "agent" && isHistoricalVersion && detail.version && (
              <Badge variant="secondary" className="font-mono">
                v{detail.version} · <span className="font-sans">{t("version.readOnly")}</span>
              </Badge>
            )}
            {detail.type === "agent" && detail.source === "system" && detail.version && (
              <Badge variant="secondary" className="font-mono">
                v{detail.version}
              </Badge>
            )}
            {detail.type === "agent" && statusBadges}
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
