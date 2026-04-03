// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import type { PackageType } from "@appstrate/core/validation";
import { packageListPath } from "../../lib/package-paths";
import { InlineMarkdown } from "../markdown";
import { PageHeader } from "../page-header";

const emojiMap: Record<PackageType, string> = {
  agent: "⚡",
  skill: "🧠",
  tool: "🔧",
  provider: "🔌",
};

interface SharedHeaderDetail {
  id: string;
  displayName: string;
  description: string;
  source: string;
  type: PackageType;
  version?: string | null;
}

export function SharedHeader({
  detail,
  isHistoricalVersion,
  actionsLeft,
  actionsRight,
}: {
  detail: SharedHeaderDetail;
  isHistoricalVersion: boolean;
  actionsLeft?: React.ReactNode;
  actionsRight?: React.ReactNode;
}) {
  const { t } = useTranslation(["agents", "settings", "common"]);

  const breadcrumbPath = packageListPath(detail.type);
  const breadcrumbLabel =
    detail.type === "agent"
      ? t("detail.breadcrumb")
      : t(`packages.type.${detail.type}s`, { ns: "settings" });

  return (
    <>
      <PageHeader
        title={detail.displayName}
        emoji={emojiMap[detail.type]}
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: breadcrumbLabel, href: breadcrumbPath },
          { label: detail.displayName },
        ]}
        actions={
          <>
            {detail.source === "system" && (
              <span title={t("packages.sourceBuiltIn", { ns: "settings" })}>
                <ShieldCheck className="text-muted-foreground h-4 w-4" />
              </span>
            )}
            {detail.version && (
              <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[0.65rem] font-medium">
                v{detail.version}
              </span>
            )}
            {isHistoricalVersion && (
              <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[0.65rem] font-medium">
                {t("version.readOnly")}
              </span>
            )}
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
