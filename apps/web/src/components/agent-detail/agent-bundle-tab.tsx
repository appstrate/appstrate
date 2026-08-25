// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import type { AgentDetail } from "@appstrate/shared-types";
import { FileExplorer } from "../package-files/file-explorer";
import { VersionHistory } from "../version-history";
import { JsonView } from "../json-view";

type BundleSection = "overview" | "files" | "dependencies" | "schemas" | "versions";

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-muted/25 rounded-lg border p-4">
      <p className="text-muted-foreground text-xs">{label}</p>
      <div className="mt-1 text-sm font-medium">{value}</div>
    </div>
  );
}

export function AgentBundleTab({
  packageId,
  detail,
  version,
  isOwned,
}: {
  packageId: string;
  detail: AgentDetail;
  version?: string;
  isOwned: boolean;
}) {
  const { t } = useTranslation("agents");
  const [section, setSection] = useState<BundleSection>("overview");
  const promptLength = detail.prompt?.length ?? 0;
  const inputCount = Object.keys(detail.input?.schema?.properties ?? {}).length;
  const outputCount = Object.keys(detail.output?.schema?.properties ?? {}).length;

  return (
    <div className="space-y-4" data-agent-bundle>
      <div>
        <h2 className="text-xl font-semibold">{t("detail.bundle.title")}</h2>
        <p className="text-muted-foreground mt-1 text-sm">{t("detail.bundle.description")}</p>
      </div>
      <Tabs value={section} onValueChange={(value) => setSection(value as BundleSection)}>
        <div className="max-w-full overflow-x-auto pb-1">
          <TabsList className="w-max">
            <TabsTrigger value="overview">{t("detail.bundle.overview")}</TabsTrigger>
            <TabsTrigger value="files">{t("detail.bundle.files")}</TabsTrigger>
            <TabsTrigger value="dependencies">{t("detail.bundle.dependencies")}</TabsTrigger>
            <TabsTrigger value="schemas">{t("detail.bundle.schemas")}</TabsTrigger>
            <TabsTrigger value="versions">{t("detail.bundle.versions")}</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Fact label={t("detail.bundle.manifest")} value={t("detail.bundle.valid")} />
            <Fact
              label={t("detail.bundle.prompt")}
              value={t("detail.bundle.characterCount", { count: promptLength })}
            />
            <Fact
              label={t("detail.bundle.inputSchema")}
              value={t("detail.overview.fieldCount", { count: inputCount })}
            />
            <Fact
              label={t("detail.bundle.outputSchema")}
              value={
                detail.output?.schema
                  ? t("detail.overview.fieldCount", { count: outputCount })
                  : t("detail.overview.unknown")
              }
            />
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <Fact
              label={t("detail.overview.skills")}
              value={t("detail.overview.itemCount", { count: detail.dependencies.skills.length })}
            />
            <Fact
              label={t("detail.overview.integrations")}
              value={t("detail.overview.itemCount", {
                count: detail.dependencies.integrations.length,
              })}
            />
            <Fact
              label={t("detail.overview.mcpServers")}
              value={t("detail.overview.itemCount", {
                count: detail.dependencies.mcp_servers.length,
              })}
            />
          </div>
        </TabsContent>

        <TabsContent value="files" className="mt-4">
          <FileExplorer packageId={packageId} type="agent" version={version} />
        </TabsContent>

        <TabsContent value="dependencies" className="mt-4 space-y-4">
          <section className="rounded-lg border p-4">
            <h3 className="text-sm font-semibold">{t("detail.overview.skills")}</h3>
            <div className="mt-3 space-y-2">
              {detail.dependencies.skills.map((skill) => (
                <div key={skill.id} className="flex justify-between gap-3 text-sm">
                  <code>{skill.id}</code>
                  <span className="text-muted-foreground">{skill.version ?? "—"}</span>
                </div>
              ))}
            </div>
          </section>
          <section className="rounded-lg border p-4">
            <h3 className="text-sm font-semibold">{t("detail.overview.integrations")}</h3>
            <div className="mt-3 space-y-2">
              {detail.dependencies.integrations.map((integration) => (
                <div key={integration.id} className="flex justify-between gap-3 text-sm">
                  <code>{integration.id}</code>
                  <span className="text-muted-foreground">{integration.version}</span>
                </div>
              ))}
            </div>
          </section>
          <section className="rounded-lg border p-4">
            <h3 className="text-sm font-semibold">{t("detail.overview.mcpServers")}</h3>
            <div className="mt-3 space-y-2">
              {detail.dependencies.mcp_servers.map((server) => (
                <div key={server.id} className="flex justify-between gap-3 text-sm">
                  <code>{server.id}</code>
                  <span className="text-muted-foreground">{server.version}</span>
                </div>
              ))}
            </div>
          </section>
        </TabsContent>

        <TabsContent value="schemas" className="mt-4 grid gap-4 lg:grid-cols-2">
          <section className="min-w-0 rounded-lg border p-4">
            <h3 className="mb-3 text-sm font-semibold">{t("detail.bundle.inputSchema")}</h3>
            {detail.input?.schema ? (
              <JsonView data={detail.input.schema} />
            ) : (
              <p className="text-muted-foreground text-sm">{t("detail.overview.unknown")}</p>
            )}
          </section>
          <section className="min-w-0 rounded-lg border p-4">
            <h3 className="mb-3 text-sm font-semibold">{t("detail.bundle.outputSchema")}</h3>
            {detail.output?.schema ? (
              <JsonView data={detail.output.schema} />
            ) : (
              <p className="text-muted-foreground text-sm">{t("detail.overview.unknown")}</p>
            )}
          </section>
        </TabsContent>

        <TabsContent value="versions" className="mt-4">
          <VersionHistory packageId={packageId} type="agent" isOwned={isOwned} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
