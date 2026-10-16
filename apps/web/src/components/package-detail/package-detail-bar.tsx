// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import type { PackageType } from "@appstrate/core/validation";
import { Badge } from "@appstrate/ui/components/badge";
import { DetailBar, DetailBarId } from "../detail-bar";
import type { DetailTab } from "../detail-tabs";
import { PackageIcon } from "../package-icon";
import { usePackageListCrumb } from "../../hooks/use-package-list-crumb";

interface PackageDetailBarDetail {
  id: string;
  displayName: string;
  source: string;
  type: PackageType;
  version?: string | null;
  /** Raw image URL or Iconify id for integrations. */
  icon?: string;
  /**
   * Name of the space this package lives in — the one whose permissions decide
   * who may edit it. Absent for the org catalog and for a home the reader
   * cannot enter.
   */
  homeSpaceName?: string | null;
}

/**
 * The page header of every package type but the agent, whose is `AgentDetailBar`:
 * title, version and state pills, trail and id, actions and tabs, in the
 * shell header. The package's description is in its overview tab.
 */
export function PackageDetailBar<T extends string>({
  detail,
  isHistoricalVersion,
  hasUnarchivedChanges,
  status,
  tabs,
  actions,
}: {
  detail: PackageDetailBarDetail;
  isHistoricalVersion: boolean;
  hasUnarchivedChanges?: boolean;
  /** Another pill after the version: an integration's activation, or its placeholder. */
  status?: ReactNode;
  tabs: readonly DetailTab<T>[];
  actions?: ReactNode;
}) {
  const { t } = useTranslation(["agents", "settings"]);
  const listCrumb = usePackageListCrumb(detail.type);

  return (
    <DetailBar
      icon={<PackageIcon type={detail.type} icon={detail.icon} />}
      title={detail.displayName}
      badge={
        <>
          {detail.version && (
            <Badge variant="secondary" className="shrink-0 font-mono">
              v{detail.version}
            </Badge>
          )}
          {hasUnarchivedChanges && !isHistoricalVersion && (
            <Badge variant="warning" className="shrink-0">
              {t("version.modified")}
            </Badge>
          )}
          {isHistoricalVersion && (
            <Badge variant="secondary" className="shrink-0">
              {t("version.readOnly")}
            </Badge>
          )}
          {status}
        </>
      }
      trail={[listCrumb]}
      meta={
        <>
          <DetailBarId id={detail.id} />
          {/* Where the package comes from and where it LIVES, which is where it
              may be edited: facts, kept off a phone's one line. */}
          {detail.source === "system" && (
            <span className="hidden shrink-0 items-center gap-1 sm:inline-flex">
              <span aria-hidden>·</span>
              <ShieldCheck className="size-3" aria-hidden />
              {t("list.badgeBuiltIn", { ns: "agents" })}
            </span>
          )}
          {detail.homeSpaceName && (
            <span className="hidden shrink-0 items-center gap-1.5 md:inline-flex">
              <span aria-hidden>·</span>
              {t("packages.homeSpace", { ns: "settings", space: detail.homeSpaceName })}
            </span>
          )}
        </>
      }
      actions={actions}
      tabs={tabs}
    />
  );
}
