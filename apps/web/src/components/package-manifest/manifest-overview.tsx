// SPDX-License-Identifier: Apache-2.0

/**
 * The manifest metadata a package overview shows below its own summary cards.
 *
 * Everything rendered here is AUTHOR-CONTROLLED text. It reaches the screen as
 * JSX children and nothing else; the only string that becomes an `href` is one
 * `normalizeHttpUrl` accepted.
 */

import { useTranslation } from "react-i18next";
import { Badge } from "@appstrate/ui/components/badge";
import { readManifestOverview } from "../../lib/package-manifest";
import { DetailSectionCard } from "../detail-section-card";
import { FactGrid } from "./manifest-fact";

export function ManifestOverview({ manifest }: { manifest: unknown }) {
  const { t } = useTranslation("agents");
  const overview = readManifestOverview(manifest);
  if (overview.isEmpty) return null;

  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      {overview.longDescription && (
        <DetailSectionCard bodyClassName="space-y-4 p-4" title={t("manifest.longDescription")}>
          <p className="text-sm whitespace-pre-wrap">{overview.longDescription}</p>
        </DetailSectionCard>
      )}

      {overview.facts.length > 0 && (
        <DetailSectionCard bodyClassName="space-y-4 p-4" title={t("manifest.metadata")}>
          <FactGrid facts={overview.facts} />
        </DetailSectionCard>
      )}

      {overview.keywords.length > 0 && (
        <DetailSectionCard bodyClassName="space-y-4 p-4" title={t("manifest.keywords")}>
          <div className="flex flex-wrap gap-1.5">
            {/* Index in the key: `keywords` is author-controlled jsonb and the
                reader keeps duplicates verbatim rather than editing the data to
                make a React key unique. */}
            {overview.keywords.map((keyword, index) => (
              <Badge key={`${index}:${keyword}`} variant="secondary">
                {keyword}
              </Badge>
            ))}
          </div>
        </DetailSectionCard>
      )}

      {overview.links.length > 0 && (
        <DetailSectionCard bodyClassName="space-y-4 p-4" title={t("manifest.links")}>
          <FactGrid facts={overview.links} />
        </DetailSectionCard>
      )}

      {overview.dependencies.length > 0 && (
        <DetailSectionCard bodyClassName="space-y-4 p-4" title={t("manifest.dependencies")}>
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
        </DetailSectionCard>
      )}
    </div>
  );
}
