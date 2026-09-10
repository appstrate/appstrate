// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ShieldCheck, Wrench, Plug, Blocks } from "lucide-react";
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
import { AgentIdentityTile } from "../agent-identity";

interface SharedHeaderDetail {
  id: string;
  displayName: string;
  description: string;
  source: string;
  type: PackageType;
  version?: string | null;
  /** AFPS icon token for agents, raw image URL or Iconify id for integrations. */
  icon?: string;
  /** Appstrate Agent presentation colour token. */
  color?: string;
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
    detail.type === "agent" ? (
      <AgentIdentityTile
        agentId={detail.id}
        icon={detail.icon}
        color={detail.color}
        className="size-10 rounded-[10px]"
      />
    ) : detail.type === "integration" && detail.icon ? (
      <IntegrationIcon src={detail.icon} />
    ) : (
      <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-[10px]">
        {detail.type === "skill" ? (
          <Wrench className="size-5" aria-hidden />
        ) : detail.type === "mcp-server" ? (
          <Plug className="size-5" aria-hidden />
        ) : (
          <Blocks className="size-5" aria-hidden />
        )}
      </span>
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
