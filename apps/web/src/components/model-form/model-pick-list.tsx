// SPDX-License-Identifier: Apache-2.0

/**
 * The models a provider offers, as checkbox rows the dialog's footer adds in
 * one go. A row shows only what its description carried; `source` says who
 * described it.
 */

import { useTranslation } from "react-i18next";
import { Star } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { cn } from "@appstrate/ui/cn";
import { Spinner } from "../spinner";
import type { ModelPickRow } from "@/lib/model-source";

/** What a row can offer beyond its tick, once the list is told how (the provider's models dialog). */
interface RowExtras {
  /** The upstream id starred as the organization's default. */
  defaultId?: string | null;
  onDefaultChange?: (id: string) => void;
  /** The row that cannot be unticked: the organization's default model keeps its access. */
  lockedId?: string | null;
  /** The rows already saved, whose finer settings open in the model form. */
  advancedIds?: ReadonlySet<string>;
  onAdvanced?: (id: string) => void;
}

function PickRow({
  id,
  row,
  checked,
  onCheckedChange,
  extras,
}: {
  id: string;
  row: ModelPickRow;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  extras: RowExtras;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const locked = extras.lockedId === row.id;
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <span title={locked ? t("models.choice.defaultLocked") : undefined} className="inline-flex">
        <Checkbox
          id={id}
          checked={checked}
          disabled={locked}
          onCheckedChange={(v) => onCheckedChange(Boolean(v))}
        />
      </span>
      <Label htmlFor={id} className="min-w-0 flex-1 cursor-pointer font-normal">
        <span className="block truncate">{row.label ?? row.id}</span>
        {row.label && (
          <span className="text-muted-foreground block truncate font-mono text-xs">{row.id}</span>
        )}
      </Label>
      {row.contextWindow !== null && (
        <span className="text-muted-foreground shrink-0 text-xs">
          {Math.round(row.contextWindow / 1000)}k
        </span>
      )}
      {extras.onAdvanced && extras.advancedIds?.has(row.id) && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto shrink-0 p-0 text-xs"
          onClick={() => extras.onAdvanced?.(row.id)}
        >
          {t("models.choice.advanced")}
        </Button>
      )}
      {extras.onDefaultChange && checked && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-pressed={extras.defaultId === row.id}
          aria-label={
            extras.defaultId === row.id
              ? t("models.choice.isDefault", { name: row.label ?? row.id })
              : t("models.choice.setDefault", { name: row.label ?? row.id })
          }
          title={t("models.default")}
          onClick={() => extras.onDefaultChange?.(row.id)}
        >
          <Star
            className={cn(
              "size-4",
              extras.defaultId === row.id ? "fill-warning text-warning" : "text-muted-foreground",
            )}
          />
        </Button>
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
  ...extras
}: RowExtras & {
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
  // `mdl-pick-N` names the Nth row currently shown: grouping cannot renumber
  // it, a search does.
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
          extras={extras}
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
