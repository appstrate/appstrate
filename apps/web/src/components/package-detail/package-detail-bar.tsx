// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { PackageType } from "@appstrate/core/validation";
import { Badge } from "@appstrate/ui/components/badge";
import { DetailBar, DetailBarId } from "../detail-bar";
import type { DetailTab } from "../detail-tabs";
import { PackageIcon } from "../package-icon";
import { PackageOriginMeta } from "../package-origin-meta";
import { PackageSpaces } from "../package-spaces";
import { homeNameBesideTiles } from "../../lib/package-home";
import { SkeletonLine } from "../skeleton-line";
import { usePackageListCrumb } from "../../hooks/use-package-list-crumb";

interface PackageDetailBarDetail {
  id: string;
  displayName: string;
  source: string;
  type: PackageType;
  version?: string | null;
  /** Raw image URL or Iconify id for integrations. */
  icon?: string | null;
  /**
   * Name of the space this package lives in — the one whose permissions decide
   * who may edit it. Absent for the org catalog and for a home the reader
   * cannot enter. Said only when no space tile names it (`homeNameBesideTiles`).
   */
  homeSpaceName?: string | null;
  /** The home, when the reader reaches it (`home_space_id`). */
  homeSpaceId: string | null;
  /** The spaces the reader reaches where the package is active, home first (`space_ids`); `undefined` while read. */
  spaceIds: readonly string[] | undefined;
}

/**
 * The page header of every package type but the agent, whose is `AgentDetailBar`:
 * title, version and state pills, trail, the spaces the package is active in and its id,
 * actions and tabs, in the shell header. The package's description is in its overview tab.
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
      icon={
        <PackageIcon
          type={detail.type}
          id={detail.id}
          name={detail.displayName}
          icon={detail.icon}
        />
      }
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
      spaces={
        detail.spaceIds === undefined ? (
          <SkeletonLine className="w-24 text-xs leading-5" />
        ) : detail.spaceIds.length > 0 ? (
          <PackageSpaces item={detail} />
        ) : undefined
      }
      meta={
        <>
          <DetailBarId id={detail.id} />
          <PackageOriginMeta source={detail.source} homeSpaceName={homeNameBesideTiles(detail)} />
        </>
      }
      actions={actions}
      tabs={tabs}
    />
  );
}
