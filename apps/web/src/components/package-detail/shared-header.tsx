// SPDX-License-Identifier: Apache-2.0

import { ToneBadge } from "@/components/app-ui/status-variants";
import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import type { PackageType } from "@appstrate/core/validation";
import { Badge } from "@appstrate/ui/components/badge";
import { packageDetailPath } from "../../lib/package-paths";
import { InlineMarkdown } from "../markdown";
import { PageHeader } from "../page-header";
import { usePackageListCrumb } from "../../hooks/use-package-list-crumb";
import { PackageIcon } from "../package-icon";

interface SharedHeaderDetail {
  id: string;
  displayName: string;
  description: string;
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

/** The page header of every package type but the agent, whose is `AgentDetailBar`. */
export function SharedHeader({
  detail,
  isHistoricalVersion,
  hasUnarchivedChanges,
  activeSubpage,
  actionsLeft,
  actionsRight,
}: {
  detail: SharedHeaderDetail;
  isHistoricalVersion: boolean;
  hasUnarchivedChanges?: boolean;
  activeSubpage?: { label: string };
  actionsLeft?: React.ReactNode;
  actionsRight?: React.ReactNode;
}) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  const listCrumb = usePackageListCrumb(detail.type);

  const iconNode = <PackageIcon type={detail.type} icon={detail.icon} />;

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
            {detail.source === "system" && (
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
            {detail.version && (
              <Badge variant="secondary" className="font-mono">
                v{detail.version}
              </Badge>
            )}
            {hasUnarchivedChanges && !isHistoricalVersion && (
              <ToneBadge variant="warning">{t("version.modified")}</ToneBadge>
            )}
            {isHistoricalVersion && <Badge variant="secondary">{t("version.readOnly")}</Badge>}
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
