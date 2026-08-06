// SPDX-License-Identifier: Apache-2.0

/**
 * The single row shape the manifest view uses: a label above its value.
 *
 * The value becomes an `<a>` only when the reader already proved it is an
 * http(s) URL (`safeHttpUrl`) — this component never decides that itself, so
 * there is one place in the codebase where a manifest string can turn into an
 * href, and it is not a JSX file.
 */

import { useTranslation } from "react-i18next";
import type { ManifestLink } from "../../lib/package-manifest";

export function FactGrid({ facts }: { facts: ManifestLink[] }) {
  const { t } = useTranslation("agents");
  if (facts.length === 0) return null;

  return (
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {facts.map((entry) => (
        <div key={`${entry.labelKey}:${entry.value}`} className="min-w-0">
          <dt className="text-muted-foreground text-xs">{t(entry.labelKey)}</dt>
          <dd className="text-sm break-words">
            {entry.href ? (
              <a
                href={entry.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline"
              >
                {entry.value}
              </a>
            ) : (
              entry.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
