// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import type { PackageType } from "@appstrate/core/validation";
import { Badge } from "@appstrate/ui/components/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appstrate/ui/components/tooltip";
import { packageDetailPath, packageListPath } from "../../lib/package-paths";
import { InlineMarkdown } from "../markdown";
import { PageHeader } from "../page-header";
import { IntegrationIcon } from "../integration-icon";

const emojiMap: Record<PackageType, string> = {
  agent: "⚡",
  skill: "🧠",
  "mcp-server": "🔌",
  integration: "🧩",
};

interface SharedHeaderDetail {
  id: string;
  displayName: string;
  description: string;
  source: string;
  type: PackageType;
  version?: string | null;
  /** Raw AFPS manifest `icon` (image URL or Iconify id); integrations only. */
  icon?: string;
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

  const iconNode =
    detail.type === "integration" && detail.icon ? (
      <IntegrationIcon src={detail.icon} />
    ) : undefined;

  return (
    <>
      <PageHeader
        title={detail.displayName}
        titleClassName={detail.type === "agent" ? "text-xl" : undefined}
        emoji={emojiMap[detail.type]}
        icon={iconNode}
        wrapActions={detail.type === "integration" || detail.type === "agent"}
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
              <span title={t("packages.sourceBuiltIn", { ns: "settings" })}>
                <ShieldCheck className="text-muted-foreground h-4 w-4" />
              </span>
            )}
            {detail.type !== "agent" && detail.version && (
              <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[0.65rem] font-medium">
                v{detail.version}
              </span>
            )}
            {detail.type !== "agent" && hasUnarchivedChanges && !isHistoricalVersion && (
              <span className="bg-warning/15 text-warning rounded px-1.5 py-0.5 text-[0.65rem] font-medium">
                {t("version.modified")}
              </span>
            )}
            {detail.type !== "agent" && isHistoricalVersion && (
              <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[0.65rem] font-medium">
                {t("version.readOnly")}
              </span>
            )}
            {detail.type === "agent" && detail.source === "system" && (
              <TooltipProvider delayDuration={250}>
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
              </TooltipProvider>
            )}
            {detail.type === "agent" && detail.source !== "system" && !isHistoricalVersion && (
              <TooltipProvider delayDuration={250}>
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
              </TooltipProvider>
            )}
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
