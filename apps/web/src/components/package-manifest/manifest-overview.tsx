// SPDX-License-Identifier: Apache-2.0

/** Author-controlled text: reaches the screen only as JSX children; the only `href` is one `normalizeHttpUrl` accepted. */

import { useTranslation } from "react-i18next";
import { Badge } from "@appstrate/ui/components/badge";
import { readManifestOverview } from "../../lib/package-manifest";
import { SettingsGroup } from "../settings/setting-row";
import { ManifestFacts } from "./manifest-fact";

/**
 * What the package's manifest says about itself beyond its one-line description — the long
 * description, author, licence, keywords, links — for the catalogue sheet, the one place that
 * describes a package (its dependencies are the sheet's own group).
 */
export function ManifestOverview({ manifest }: { manifest: unknown }) {
  const { t } = useTranslation("agents");
  const overview = readManifestOverview(manifest);
  if (overview.isEmpty) return null;

  return (
    <SettingsGroup title={t("manifest.metadata")} className="mb-6">
      <div className="flex flex-col gap-4 border-t pt-4">
        {overview.longDescription && (
          <p className="text-sm whitespace-pre-wrap">{overview.longDescription}</p>
        )}
        {overview.facts.length > 0 && <ManifestFacts facts={overview.facts} />}
        {overview.keywords.length > 0 && (
          <div className="flex flex-wrap gap-1.5" aria-label={t("manifest.keywords")}>
            {/* Index in the key: `keywords` is author-controlled jsonb and the reader keeps
                duplicates verbatim rather than editing the data to make a React key unique. */}
            {overview.keywords.map((keyword, index) => (
              <Badge key={`${index}:${keyword}`} variant="secondary">
                {keyword}
              </Badge>
            ))}
          </div>
        )}
        {overview.links.length > 0 && <ManifestFacts facts={overview.links} />}
      </div>
    </SettingsGroup>
  );
}
