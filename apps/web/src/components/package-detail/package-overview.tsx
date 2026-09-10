// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { BookOpen, FileCode, FolderOpen, Layers, Server, Tags, Wrench } from "lucide-react";
import { DetailSectionCard } from "../detail-section-card";
import { Markdown } from "../markdown";
import { ManifestOverview } from "../package-manifest/manifest-overview";
import { McpServerDetails } from "../package-manifest/mcp-server-details";
import { readManifestOverview, readMcpServerDetails } from "../../lib/package-manifest";

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
  const metadata = readManifestOverview(manifest);
  return (
    <div className="space-y-6" data-testid="package-overview">
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <DetailSectionCard
          headerInside
          title={t("packageOverview.role")}
          icon={type === "skill" ? BookOpen : Server}
        >
          <p className="text-sm">{description || t(roleFallbackKeys[type])}</p>
        </DetailSectionCard>
        <DetailSectionCard headerInside title={t("packageOverview.package")} icon={Tags}>
          <dl className="grid grid-cols-2 gap-4">
            <div>
              <dt className="text-muted-foreground text-xs">{t("run.infoVersion")}</dt>
              <dd className="mt-1 text-sm">{version || t("version.draft")}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">{t("packageOverview.view")}</dt>
              <dd className="mt-1 text-sm">
                {t(historical ? "packageOverview.published" : "packageOverview.current")}
              </dd>
            </div>
          </dl>
        </DetailSectionCard>
        {type === "skill" && (
          <DetailSectionCard
            headerInside
            title={t("packageOverview.instructions")}
            icon={FileCode}
            headerAction={{ label: t("packageOverview.openInstructions"), onClick: onOpenFiles }}
          >
            {content?.trim() ? (
              <div className="max-h-52 overflow-hidden">
                <Markdown inert className="text-sm [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm">
                  {content}
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
          headerInside
          title={t("packageOverview.usage")}
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
          headerInside
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
          <DetailSectionCard headerInside title={t("manifest.tools")} icon={Wrench}>
            <p className="text-sm">{t("packageOverview.noDeclaredTools")}</p>
          </DetailSectionCard>
        )}
      </div>
      {!metadata.isEmpty && <ManifestOverview manifest={manifest} type={type} metadataOnly />}
    </div>
  );
}
