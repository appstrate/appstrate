// SPDX-License-Identifier: Apache-2.0

/** MCP-server tail of the manifest overview (`server`, `tools`, `user_config`); `manifest.json` is this type's only required file, so it has no other view. */

import { useTranslation } from "react-i18next";
import { Badge } from "@appstrate/ui/components/badge";
import type { ManifestFact, McpServerManifestDetails } from "../../lib/package-manifest";
import { DetailSectionCard } from "../detail-section-card";
import { ManifestFacts } from "./manifest-fact";
import { PackageToolCatalog } from "../package-detail/package-tool-catalog";

export function McpServerDetails({ details }: { details: McpServerManifestDetails }) {
  const { t } = useTranslation("agents");
  const { manifestVersion, server, tools, userConfig } = details;

  const facts: ManifestFact[] = [];
  if (manifestVersion) {
    facts.push({ labelKey: "manifest.manifestVersion", value: manifestVersion });
  }
  if (server?.runtime) facts.push({ labelKey: "manifest.serverRuntime", value: server.runtime });
  if (server?.entryPoint) {
    facts.push({ labelKey: "manifest.serverEntryPoint", value: server.entryPoint });
  }
  if (server?.command) {
    // Args stay with the command: split, they read as two unrelated facts.
    facts.push({
      labelKey: "manifest.serverCommand",
      value: [server.command, ...server.args].join(" "),
    });
  }

  return (
    <>
      {facts.length > 0 && (
        <DetailSectionCard bodyClassName="space-y-4 p-4" title={t("manifest.server")}>
          <ManifestFacts facts={facts} />
        </DetailSectionCard>
      )}

      {tools.length > 0 && (
        <DetailSectionCard
          bodyClassName="space-y-4 p-4"
          title={t("manifest.tools")}
          className="lg:col-span-2"
        >
          <PackageToolCatalog tools={tools} />
        </DetailSectionCard>
      )}

      {userConfig.length > 0 && (
        <DetailSectionCard bodyClassName="space-y-4 p-4" title={t("manifest.userConfig")}>
          {userConfig.map((entry) => (
            <div key={entry.key}>
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-sm">{entry.key}</code>
                {entry.type && <Badge variant="secondary">{entry.type}</Badge>}
                {entry.required && <Badge variant="outline">{t("manifest.required")}</Badge>}
                {entry.sensitive && <Badge variant="warning">{t("manifest.sensitive")}</Badge>}
              </div>
              {(entry.title ?? entry.description) && (
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {entry.title && entry.description
                    ? `${entry.title} — ${entry.description}`
                    : (entry.title ?? entry.description)}
                </p>
              )}
            </div>
          ))}
        </DetailSectionCard>
      )}
    </>
  );
}
