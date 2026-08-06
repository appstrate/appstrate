// SPDX-License-Identifier: Apache-2.0

/**
 * MCP-server-specific tail of the manifest overview: how the server is started
 * (`server`), what it exposes (`tools`) and what it asks the installer for
 * (`user_config`). `manifest.json` IS the only required file of this package
 * type, so without this block the type has no rendered view at all.
 */

import { useTranslation } from "react-i18next";
import { Badge } from "@appstrate/ui/components/badge";
import type { ManifestFact, McpServerManifestDetails } from "../../lib/package-manifest";
import { SectionCard } from "../section-card";
import { FactGrid } from "./manifest-fact";

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
    // The args belong with the command — split across two rows they read as
    // two unrelated facts instead of the one line the runner executes.
    facts.push({
      labelKey: "manifest.serverCommand",
      value: [server.command, ...server.args].join(" "),
    });
  }

  return (
    <>
      {facts.length > 0 && (
        <SectionCard title={t("manifest.server")}>
          <FactGrid facts={facts} />
        </SectionCard>
      )}

      {tools.length > 0 && (
        <SectionCard title={t("manifest.tools")}>
          {tools.map((tool) => (
            <div key={tool.name}>
              <code className="text-sm">{tool.name}</code>
              {tool.description && (
                <p className="text-muted-foreground mt-0.5 text-xs">{tool.description}</p>
              )}
            </div>
          ))}
        </SectionCard>
      )}

      {userConfig.length > 0 && (
        <SectionCard title={t("manifest.userConfig")}>
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
        </SectionCard>
      )}
    </>
  );
}
