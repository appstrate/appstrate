// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { BookOpen, FileCode, FolderOpen, Layers, Server, Tags, Wrench } from "lucide-react";
import { DetailSectionCard } from "../detail-section-card";
import { Fact, FactGrid } from "@appstrate/ui/components/fact-grid";
import { Markdown } from "../markdown";
import { ManifestOverview } from "../package-manifest/manifest-overview";
import { McpServerDetails } from "../package-manifest/mcp-server-details";
import { readMcpServerDetails } from "../../lib/package-manifest";
import { skillBody } from "../../lib/skill-frontmatter";
import { SkeletonLine } from "../skeleton-line";

const roleFallbackKeys = {
  skill: "packageOverview.roleFallback.skill",
  "mcp-server": "packageOverview.roleFallback.mcp-server",
  integration: "packageOverview.roleFallback.integration",
} as const;

/** A package summary uses its substance and usage, not optional metadata alone. */
export function PackageOverview({
  type,
  description,
  content,
  manifest,
  version,
  historical,
  agentCount,
  onOpenFiles,
  onOpenUsage,
}: {
  type: "skill" | "mcp-server" | "integration";
  description: string;
  content?: string | null;
  manifest: unknown;
  version?: string | null;
  historical: boolean;
  agentCount: number;
  onOpenFiles: () => void;
  onOpenUsage: () => void;
}) {
  const { t } = useTranslation("agents");
  const server = readMcpServerDetails(manifest);
  const instructions = type === "skill" && content ? skillBody(content) : "";
  return (
    <div className="flex flex-col gap-6" data-testid="package-overview">
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <DetailSectionCard
          title={t("packageOverview.role")}
          icon={type === "skill" ? BookOpen : Server}
        >
          <p className="text-sm">{description || t(roleFallbackKeys[type])}</p>
        </DetailSectionCard>
        <DetailSectionCard title={t("packageOverview.package")} icon={Tags}>
          <FactGrid columns={2}>
            <Fact label={t("run.infoVersion")}>{version || t("version.draft")}</Fact>
            <Fact label={t("packageOverview.view")}>
              {t(historical ? "packageOverview.published" : "packageOverview.current")}
            </Fact>
          </FactGrid>
        </DetailSectionCard>
        {type === "skill" && (
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
        )}
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
          <p className="text-sm">
            {t(type === "skill" ? "packageOverview.skillFiles" : "packageOverview.serverFiles")}
          </p>
        </DetailSectionCard>
        {type === "mcp-server" && <McpServerDetails details={server} />}
        {type === "mcp-server" && server.tools.length === 0 && (
          <DetailSectionCard title={t("manifest.tools")} icon={Wrench}>
            <p className="text-sm">{t("packageOverview.noDeclaredTools")}</p>
          </DetailSectionCard>
        )}
      </div>
      <ManifestOverview manifest={manifest} />
    </div>
  );
}

/**
 * `PackageOverview` while the package loads: the same cards, titles and labels,
 * drawn by the same components — only what the package says waits, in its
 * own line boxes. The manifest summary under the cards has no fixed shape and
 * is left out.
 */
export function PackageOverviewSkeleton({
  type,
}: {
  type: "skill" | "mcp-server" | "integration";
}) {
  const { t } = useTranslation("agents");
  return (
    <div className="flex flex-col gap-6">
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <DetailSectionCard
          title={t("packageOverview.role")}
          icon={type === "skill" ? BookOpen : Server}
        >
          <SkeletonLine className="w-3/4 text-sm" />
        </DetailSectionCard>
        <DetailSectionCard title={t("packageOverview.package")} icon={Tags}>
          <FactGrid columns={2}>
            <Fact label={t("run.infoVersion")}>
              <SkeletonLine className="w-12" />
            </Fact>
            <Fact label={t("packageOverview.view")}>
              <SkeletonLine className="w-24" />
            </Fact>
          </FactGrid>
        </DetailSectionCard>
        {type === "skill" && (
          <DetailSectionCard title={t("packageOverview.instructions")} icon={FileCode}>
            {/* A real SKILL.md fills the clipped `max-h-52` box. */}
            <div className="h-52 overflow-hidden">
              {Array.from({ length: 11 }, (_, i) => (
                <SkeletonLine
                  key={i}
                  className={i % 4 === 3 ? "w-2/3 text-sm" : "w-full text-sm"}
                />
              ))}
            </div>
            <p className="text-muted-foreground mt-3 text-xs">
              {t("packageOverview.instructionsHint")}
            </p>
          </DetailSectionCard>
        )}
        <DetailSectionCard title={t("run.infoUsage")} icon={Layers}>
          <SkeletonLine className="w-8 text-2xl font-semibold tabular-nums" />
          <SkeletonLine className="mt-1 w-24 text-sm" />
        </DetailSectionCard>
        <DetailSectionCard title={t("detail.tabFiles")} icon={FolderOpen}>
          <p className="text-sm">
            {t(type === "skill" ? "packageOverview.skillFiles" : "packageOverview.serverFiles")}
          </p>
        </DetailSectionCard>
      </div>
    </div>
  );
}
