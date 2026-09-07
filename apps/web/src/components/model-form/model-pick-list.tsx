// SPDX-License-Identifier: Apache-2.0

/**
 * The models a provider offers, as a list to pick from.
 *
 * One listing describes every model at once — whether it came from the
 * vendored catalog, from an endpoint's own `/models`, or from a live search —
 * so adding them one at a time would be the same endpoint configured over and
 * over: the rows are checkboxes and the dialog's footer adds all of them in one
 * go. A row shows only what its description actually carried; `source` says
 * whether the endpoint published it or the catalog filled it in, and neither is
 * claimed when nothing described the model.
 */

import { useTranslation } from "react-i18next";
import { Badge } from "@appstrate/ui/components/badge";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { Spinner } from "../spinner";
import type { ModelPickRow } from "@/lib/model-source";

function PickRow({
  id,
  row,
  checked,
  onCheckedChange,
}: {
  id: string;
  row: ModelPickRow;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const sourceLabel =
    row.source === "catalog"
      ? t("models.form.discoverSourceCatalog")
      : row.source === "endpoint"
        ? t("models.form.discoverSourceEndpoint")
        : null;

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onCheckedChange(Boolean(v))} />
      <Label htmlFor={id} className="min-w-0 flex-1 cursor-pointer font-normal">
        <span className="block truncate">{row.label ?? row.id}</span>
        {row.label && (
          <span className="text-muted-foreground block truncate font-mono text-xs">{row.id}</span>
        )}
      </Label>
      {sourceLabel && (
        <Badge variant="secondary" className="shrink-0">
          {sourceLabel}
        </Badge>
      )}
      {row.contextWindow !== null && (
        <span className="text-muted-foreground shrink-0 text-xs">
          {Math.round(row.contextWindow / 1000)}k
        </span>
      )}
    </div>
  );
}

export function ModelPickList({
  rows,
  selectedIds,
  onSelectionChange,
  search,
  onSearchChange,
  isLoading,
  loadingText,
  emptyText,
  grouped,
}: {
  rows: readonly ModelPickRow[];
  selectedIds: readonly string[];
  /** The shown rows the operator just checked or unchecked. */
  onSelectionChange: (rows: ModelPickRow[], checked: boolean) => void;
  search: string;
  onSearchChange: (value: string) => void;
  isLoading: boolean;
  loadingText: string;
  emptyText: string;
  /** Split into the provider's curated group and the rest — catalog only. */
  grouped?: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  // The index is the row's place in the whole list, not in its group, so an id
  // stays stable when a search or a grouping moves it.
  const indexed = rows.map((row, index) => ({ row, index }));
  const featured = grouped ? indexed.filter((r) => r.row.featured) : [];
  const rest = grouped ? indexed.filter((r) => !r.row.featured) : indexed;
  const allSelected = rows.length > 0 && rows.every((r) => selectedIds.includes(r.id));

  const section = (items: typeof indexed, label: string | null) => (
    <>
      {label && (
        <div className="text-muted-foreground bg-muted/50 px-3 py-1 text-xs font-medium">
          {label}
        </div>
      )}
      {items.map(({ row, index }) => (
        <PickRow
          key={row.id}
          id={`mdl-pick-${index}`}
          row={row}
          checked={selectedIds.includes(row.id)}
          onCheckedChange={(checked) => onSelectionChange([row], checked)}
        />
      ))}
    </>
  );

  return (
    <div className="space-y-2">
      <Input
        id="mdl-modelSearch"
        type="search"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder={t("models.form.modelSearchPlaceholder")}
      />
      <div className="flex items-center gap-2">
        <Checkbox
          id="mdl-pick-all"
          checked={allSelected}
          onCheckedChange={(v) => onSelectionChange([...rows], Boolean(v))}
        />
        <Label htmlFor="mdl-pick-all" className="cursor-pointer font-normal">
          {t("models.form.discoverSelectAll")}
        </Label>
      </div>
      <div className="max-h-64 divide-y overflow-y-auto rounded-md border">
        {isLoading ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
            <Spinner className="size-3" />
            {loadingText}
          </div>
        ) : rows.length === 0 ? (
          <div className="text-muted-foreground px-3 py-6 text-center text-sm">{emptyText}</div>
        ) : (
          <>
            {featured.length > 0 && section(featured, t("models.form.modelGroupFeatured"))}
            {rest.length > 0 &&
              section(rest, featured.length > 0 ? t("models.form.modelGroupAll") : null)}
          </>
        )}
      </div>
    </div>
  );
}
