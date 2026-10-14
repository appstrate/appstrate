// SPDX-License-Identifier: Apache-2.0

/**
 * The manifest view's facts, drawn through the shared `Fact` shape.
 *
 * The value becomes an `<a>` only when the reader already proved it is an
 * http(s) URL (`normalizeHttpUrl`) — this component never decides that itself, so
 * there is one place in the codebase where a manifest string can turn into an
 * href, and it is not a JSX file.
 *
 * The row key carries the INDEX because the reader does not dedupe: a
 * manifest declaring the same `privacy_policies` entry twice is legal jsonb and
 * produces two identical `labelKey:value` rows. Uniqueness is this component's
 * problem, not a reason to drop the author's second entry.
 */

import { useTranslation } from "react-i18next";
import type { ManifestLink } from "../../lib/package-manifest";
import { Fact, FactGrid } from "../fact-grid";

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
