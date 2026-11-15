// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { FileCode, FolderOpen, Layers } from "lucide-react";
import { DetailSectionCard } from "../detail-section-card";
import { Markdown } from "../markdown";
import { skillBody } from "../../lib/skill-frontmatter";
import { SkeletonLine } from "../skeleton-line";

/**
 * What a skill does here: its instructions, usage, files and tools. What it IS (description,
 * version, origin, manifest metadata) is the catalogue sheet's and the header's, not repeated here.
 */
export function PackageOverview({
  content,
  historical,
  agentCount,
  onOpenFiles,
  onOpenUsage,
}: {
  content?: string | null;
  historical: boolean;
  agentCount: number;
  onOpenFiles: () => void;
  onOpenUsage: () => void;
}) {
  const { t } = useTranslation("agents");
  const instructions = content ? skillBody(content) : "";
  return (
    <div className="flex flex-col gap-6" data-testid="package-overview">
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <DetailSectionCard
          title={t("packageOverview.instructions")}
          icon={FileCode}
          headerAction={{ label: t("packageOverview.openInstructions"), onClick: onOpenFiles }}
        >
          {instructions.trim() ? (
            <div className="max-h-52 overflow-hidden">
              <Markdown inert className="text-sm [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm">
                {instructions}
              </Markdown>
            </div>
          ) : (
            <p className="text-sm">{t("packageOverview.noInstructions")}</p>
          )}
          {content && (
            <p className="text-muted-foreground mt-3 text-xs">
              {t("packageOverview.instructionsHint")}
            </p>
          )}
        </DetailSectionCard>
        <DetailSectionCard
          title={t("run.infoUsage")}
          icon={Layers}
          headerAction={
            agentCount > 0
              ? { label: t("packageOverview.openUsage"), onClick: onOpenUsage }
              : undefined
          }
        >
          <p className="text-2xl font-semibold tabular-nums">{agentCount}</p>
          <p className="text-muted-foreground mt-1 text-sm">
            {t("packageOverview.agents", { count: agentCount })}
          </p>
          {historical && (
            <p className="text-muted-foreground mt-3 text-xs">{t("packageOverview.liveUsage")}</p>
          )}
        </DetailSectionCard>
        <DetailSectionCard
          title={t("detail.tabFiles")}
          icon={FolderOpen}
          headerAction={{ label: t("packageOverview.openFiles"), onClick: onOpenFiles }}
        >
          <p className="text-sm">{t("packageOverview.skillFiles")}</p>
        </DetailSectionCard>
      </div>
    </div>
  );
}

/**
 * `PackageOverview` while the package loads: the same cards, titles and labels,
 * drawn by the same components — only what the package says waits, in its
 * own line boxes.
 */
export function PackageOverviewSkeleton() {
  const { t } = useTranslation("agents");
  return (
    <div className="flex flex-col gap-6">
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <DetailSectionCard title={t("packageOverview.instructions")} icon={FileCode}>
          {/* A real SKILL.md fills the clipped `max-h-52` box. */}
          <div className="h-52 overflow-hidden">
            {Array.from({ length: 11 }, (_, i) => (
              <SkeletonLine key={i} className={i % 4 === 3 ? "w-2/3 text-sm" : "w-full text-sm"} />
            ))}
          </div>
          <p className="text-muted-foreground mt-3 text-xs">
            {t("packageOverview.instructionsHint")}
          </p>
        </DetailSectionCard>
        <DetailSectionCard title={t("run.infoUsage")} icon={Layers}>
          <SkeletonLine className="w-8 text-2xl font-semibold tabular-nums" />
          <SkeletonLine className="mt-1 w-24 text-sm" />
        </DetailSectionCard>
        <DetailSectionCard title={t("detail.tabFiles")} icon={FolderOpen}>
          <p className="text-sm">{t("packageOverview.skillFiles")}</p>
        </DetailSectionCard>
      </div>
    </div>
  );
}
