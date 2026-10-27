// SPDX-License-Identifier: Apache-2.0

/**
 * The manifest view's facts. A value becomes an `<a>` only when the reader already proved it http(s)
 * (`normalizeHttpUrl`) — never decided here. The row key carries the INDEX because duplicate
 * entries (legal jsonb) produce identical `labelKey:value` rows.
 */

import { useTranslation } from "react-i18next";
import type { ManifestLink } from "../../lib/package-manifest";
import { Fact, FactGrid } from "@appstrate/ui/components/fact-grid";

export function ManifestFacts({ facts }: { facts: ManifestLink[] }) {
  const { t } = useTranslation("agents");
  if (facts.length === 0) return null;

  return (
    <FactGrid>
      {facts.map((entry, index) => (
        <Fact key={`${index}:${entry.labelKey}:${entry.value}`} label={t(entry.labelKey)}>
          {entry.href ? (
            <a
              href={entry.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              {entry.value}
            </a>
          ) : (
            entry.value
          )}
        </Fact>
      ))}
    </FactGrid>
  );
}
