// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@appstrate/ui/components/badge";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { DetailBar, DetailBarId } from "../detail-bar";
import type { DetailTab } from "../detail-tabs";
import { PackageIcon } from "../package-icon";
import { usePackageListCrumb } from "../../hooks/use-package-list-crumb";

interface AgentDetailBarDetail {
  id: string;
  displayName: string;
  source: string;
  version?: string | null;
  /**
   * The page shows the latest PUBLISHED version, not the draft: what a caller
   * who may not write the agent reads (`definition: "published"`).
   */
  readsPublished?: boolean;
  icon?: string;
  color?: string;
}

/**
 * The agent page's title, version pill, actions and tabs, in the shell header.
 * The agent's description and its other metadata are in the overview tab
 * (`AgentIdentity`), not here: the band carries only what the page is, what
 * version it shows and what can be done to it.
 */
export function AgentDetailBar<T extends string>({
  detail,
  isHistoricalVersion,
  hasUnarchivedChanges,
  draftVerdictPending,
  latestPublishedVersion,
  tabs,
  actions,
}: {
  detail: AgentDetailBarDetail;
  isHistoricalVersion: boolean;
  hasUnarchivedChanges: boolean;
  /** The draft-vs-published comparison is still being read: the pill holds its place. */
  draftVerdictPending?: boolean;
  latestPublishedVersion?: string | null;
  tabs: readonly DetailTab<T>[];
  actions: ReactNode;
}) {
  const listCrumb = usePackageListCrumb("agent");

  return (
    <DetailBar
      icon={<PackageIcon type="agent" icon={detail.icon} color={detail.color} />}
      title={detail.displayName}
      badge={
        <VersionPill
          detail={detail}
          isHistoricalVersion={isHistoricalVersion}
          hasUnarchivedChanges={hasUnarchivedChanges}
          draftVerdictPending={draftVerdictPending}
          latestPublishedVersion={latestPublishedVersion}
        />
      }
      parent={listCrumb}
      meta={<DetailBarId id={detail.id} />}
      actions={actions}
      tabs={tabs}
    />
  );
}

function VersionPill({
  detail,
  isHistoricalVersion,
  hasUnarchivedChanges,
  draftVerdictPending,
  latestPublishedVersion,
}: {
  detail: AgentDetailBarDetail;
  isHistoricalVersion: boolean;
  hasUnarchivedChanges: boolean;
  draftVerdictPending?: boolean;
  latestPublishedVersion?: string | null;
}) {
  const { t } = useTranslation("agents");

  if (isHistoricalVersion) {
    return detail.version ? (
      <Badge variant="secondary" className="shrink-0 font-mono">
        v{detail.version} · <span className="font-sans">{t("version.readOnly")}</span>
      </Badge>
    ) : null;
  }
  const published = detail.version ? (
    <Badge variant="secondary" className="shrink-0 font-mono">
      v{detail.version}
    </Badge>
  ) : null;
  if (detail.source === "system" || detail.readsPublished) return published;

  // A draft that says what the last published version already says is not worth a
  // pill of its own: the version is. "Draft" means it differs, or nothing is published.
  if (draftVerdictPending) return <Skeleton className="h-5 w-14 shrink-0" />;
  if (!hasUnarchivedChanges && detail.version) return published;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="shrink-0">
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
