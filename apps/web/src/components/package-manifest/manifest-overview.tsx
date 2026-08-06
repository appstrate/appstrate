// SPDX-License-Identifier: Apache-2.0

/**
 * Rendered, read-only view of an AFPS manifest — the "Aperçu" tab.
 *
 * One generic component for all four package types: they share ~21 metadata
 * fields, and only `integration` and `mcp-server` carry a tail worth
 * rendering (a skill's schema has none; an agent's `input`/`output`/`config`
 * already have their own tabs). Before this existed the manifest was readable
 * only as raw JSON, and the structured integration view lived behind an Edit
 * affordance gated on admin + owned + non-system + non-historical — i.e. every
 * system package and every archived version had no structured view at all.
 *
 * TWO MOUNT POINTS, and that asymmetry is correct — do not "fix" it. Agents,
 * skills and mcp-servers reach this through the Aperçu tab of
 * `pages/unified-package-detail.tsx`; integrations do not use that page at all
 * (`app.tsx` routes them to `pages/integration-detail.tsx`, which has its own
 * tab set) and mount the same component in their À propos tab.
 *
 * Everything rendered here is AUTHOR-CONTROLLED text. It reaches the screen as
 * JSX children and nothing else; the only string that becomes an `href` is one
 * `safeHttpUrl` accepted. See `components/test/package-files-render-sinks.test.ts`.
 */

import { useTranslation } from "react-i18next";
import { FileJson } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import type { PackageType } from "@appstrate/core/validation";
import {
  readIntegrationDetails,
  readManifestOverview,
  readMcpServerDetails,
} from "../../lib/package-manifest";
import { SectionCard } from "../section-card";
import { EmptyState } from "../page-states";
import { FactGrid } from "./manifest-fact";
import { IntegrationDetails } from "./integration-details";
import { McpServerDetails } from "./mcp-server-details";

interface ManifestOverviewProps {
  /** The manifest of the version being viewed — jsonb, so `unknown`-shaped. */
  manifest: unknown;
  type: PackageType;
}

export function ManifestOverview({ manifest, type }: ManifestOverviewProps) {
  const { t } = useTranslation("agents");
  const overview = readManifestOverview(manifest);
  // Read here rather than inside the tails so this component can tell an
  // entirely undeclared manifest from one whose only content is its tail.
  const integration = type === "integration" ? readIntegrationDetails(manifest) : undefined;
  const mcpServer = type === "mcp-server" ? readMcpServerDetails(manifest) : undefined;

  if (overview.isEmpty && (integration?.isEmpty ?? true) && (mcpServer?.isEmpty ?? true)) {
    return <EmptyState icon={FileJson} message={t("manifest.empty")} compact />;
  }

  return (
    <div>
      {overview.longDescription && (
        <SectionCard title={t("manifest.longDescription")}>
          <p className="text-sm whitespace-pre-wrap">{overview.longDescription}</p>
        </SectionCard>
      )}

      {overview.facts.length > 0 && (
        <SectionCard title={t("manifest.metadata")}>
          <FactGrid facts={overview.facts} />
        </SectionCard>
      )}

      {overview.keywords.length > 0 && (
        <SectionCard title={t("manifest.keywords")}>
          <div className="flex flex-wrap gap-1.5">
            {overview.keywords.map((keyword) => (
              <Badge key={keyword} variant="secondary">
                {keyword}
              </Badge>
            ))}
          </div>
        </SectionCard>
      )}

      {overview.links.length > 0 && (
        <SectionCard title={t("manifest.links")}>
          <FactGrid facts={overview.links} />
        </SectionCard>
      )}

      {overview.dependencies.length > 0 && (
        <SectionCard title={t("manifest.dependencies")}>
          {overview.dependencies.map((group) => (
            <div key={group.labelKey}>
              <p className="text-muted-foreground text-xs">{t(group.labelKey)}</p>
              <ul className="mt-1 space-y-0.5">
                {group.entries.map((entry) => (
                  <li key={entry.id} className="font-mono text-sm">
                    {entry.id} <span className="text-muted-foreground">{entry.range}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </SectionCard>
      )}

      {integration && <IntegrationDetails details={integration} />}
      {mcpServer && <McpServerDetails details={mcpServer} />}
    </div>
  );
}
