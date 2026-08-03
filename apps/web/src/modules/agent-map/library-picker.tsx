// SPDX-License-Identifier: Apache-2.0

/**
 * Pick integrations from the whole catalogue, including the system ones that are
 * not active in this application yet.
 *
 * Why this exists: `ResourceSection` deliberately offers only integrations that
 * are ACTIVE here (`?active=true`), because declaring an inactive one puts the
 * agent straight into `integration_not_active` and blocks its runs. That is the
 * right default for the editor, but it also means a fresh application shows an
 * empty list while 60+ system integrations sit one activation away.
 *
 * So this picker stages activations instead of hiding them: check what you want,
 * and the dialog activates it in this application at SAVE time, right before
 * declaring it in the manifest. Nothing is activated if you cancel — which is
 * why the work happens on save and not on click.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Input } from "@appstrate/ui/components/input";
import { ShieldCheck } from "lucide-react";
import type { OrgPackageItem } from "@appstrate/shared-types";
import { usePackageList } from "../../hooks/use-packages";
import { Spinner } from "../../components/spinner";

export interface LibraryCandidate {
  id: string;
  version: string;
}

export function LibraryPicker({
  activeIds,
  selected,
  onToggle,
}: {
  /** Ids already offered by `ResourceSection` — excluded to avoid a double list. */
  activeIds: Set<string>;
  selected: LibraryCandidate[];
  onToggle: (candidate: LibraryCandidate) => void;
}) {
  const { t } = useTranslation(["agents", "agent-map"]);
  // Full catalogue (no `active` filter) — the point of this picker.
  const { data: items, isLoading } = usePackageList("integration");
  const [query, setQuery] = useState("");

  const inactive = useMemo(() => {
    const rows = (items ?? []).filter((i: OrgPackageItem) => !activeIds.has(i.id) && i.version);
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (i) =>
        i.id.toLowerCase().includes(q) ||
        (i.name ?? "").toLowerCase().includes(q) ||
        (i.description ?? "").toLowerCase().includes(q),
    );
  }, [items, activeIds, query]);

  const selectedIds = new Set(selected.map((c) => c.id));

  if (isLoading) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }
  if ((items ?? []).length === 0) return null;

  return (
    <div className="border-border mt-4 rounded-lg border">
      <div className="border-border bg-background text-foreground border-b px-4 py-3 text-xs font-semibold tracking-wide uppercase">
        {t("agent-map:library")}
      </div>
      <div className="space-y-3 p-4">
        <p className="text-muted-foreground text-xs">{t("agent-map:libraryHint")}</p>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("agent-map:librarySearch")}
        />
        {inactive.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t("agent-map:libraryNoMatch")}</p>
        ) : (
          <div className="max-h-[240px] space-y-1 overflow-y-auto">
            {inactive.map((item) => (
              <label
                key={item.id}
                className="hover:bg-muted/50 flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5"
              >
                <Checkbox
                  checked={selectedIds.has(item.id)}
                  onCheckedChange={() => onToggle({ id: item.id, version: item.version! })}
                />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5 truncate text-sm font-medium">
                    {item.name || item.id}
                    {item.source === "system" && (
                      <ShieldCheck className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                    )}
                  </span>
                  {item.description && (
                    <span className="text-muted-foreground truncate text-xs">
                      {item.description}
                    </span>
                  )}
                </div>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
