// SPDX-License-Identifier: Apache-2.0

/**
 * The bar above a list: what is narrowing it, and how it is drawn.
 *
 * The reference calls it `lt-*` and draws it once for every list screen. Runs
 * wore two stacked tab strips instead, which read as navigation (they were
 * `Tabs`), cost a full row each, and could not grow a third dimension without
 * becoming a wall.
 *
 * **The chips are the only place a filter shows.** The trigger says what the
 * dimension IS, never what is chosen in it — that was tried, and with the chips
 * right underneath it was the same words twice, plus a row of buttons that
 * changed width every time you filtered. (The reference does mark its trigger,
 * but with a COUNT, which is not the value and only earns its place once the
 * chip row can be scrolled away. Ours never is.)
 *
 * **Every dimension takes several values**, and that is what stops the chips
 * from being a duplicate: one chip per VALUE, each removable on its own, which
 * a trigger cannot express. Where a dimension has two values (kind) or one
 * (scope), selecting them all means selecting none, and it normalises to no
 * filter — so the control never claims more than it does, and the three menus
 * still work the same way.
 *
 * **The state belongs in the URL**, pushed, not replaced: a filtered list is
 * what people paste to each other, and the rule that gave modals real URLs
 * brings the same obligation — Back has to undo a filter.
 *
 * What is NOT here: the page's own actions. They have a home — `PageHeader`'s
 * `actions` slot, at title height — and moving one down here would make Runs
 * the only screen whose primary button is not where every other screen's is.
 */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, LayoutGrid, Rows3, X } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import type { ListView } from "@/stores/list-view-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterSpec {
  id: string;
  /** What the dimension is called: "Statut", "Type". */
  label: string;
  /** The chosen values. Empty means the dimension is not filtering. */
  values: string[];
  options: FilterOption[];
  onChange: (values: string[]) => void;
}

/** Selecting every value narrows nothing, so it is stored as no filter at all. */
function normalise(filter: FilterSpec, values: string[]): string[] {
  return values.length === filter.options.length ? [] : values;
}

function FilterMenu({ filter }: { filter: FilterSpec }) {
  const { t } = useTranslation("common");
  const chosen = new Set(filter.values);

  const toggle = (value: string) => {
    const next = chosen.has(value)
      ? filter.values.filter((v) => v !== value)
      : [...filter.values, value];
    filter.onChange(normalise(filter, next));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="bg-card hover:bg-accent data-[state=open]:bg-accent inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-sm font-medium shadow-sm transition-colors">
        {filter.label}
        <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuLabel>{filter.label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {/* "All" is an item, not the absence of one: a menu whose only way back
            is the chip row hides the way back inside another control. */}
        <DropdownMenuItem onSelect={() => filter.onChange([])}>
          <Check className={cn("size-4", chosen.size > 0 && "invisible")} />
          {t("toolbar.any")}
        </DropdownMenuItem>
        {filter.options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            // The menu stays open: picking two statuses is one gesture, and a
            // menu that closes on the first tick makes the second one a chore.
            onSelect={(event) => {
              event.preventDefault();
              toggle(option.value);
            }}
          >
            <Check className={cn("size-4", !chosen.has(option.value) && "invisible")} />
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Cards or table, for the lists the reference draws both ways (`view-toggle`).
 *
 * Two icons rather than two words: the choice is between two pictures of the
 * same data, and the pictures are what the icons are.
 */
function ViewToggle({ view, onChange }: { view: ListView; onChange: (view: ListView) => void }) {
  const { t } = useTranslation("common");
  const options: Array<{ id: ListView; icon: typeof Rows3; label: string }> = [
    { id: "cards", icon: LayoutGrid, label: t("toolbar.viewCards") },
    { id: "table", icon: Rows3, label: t("toolbar.viewTable") },
  ];

  return (
    <div className="bg-card inline-flex shrink-0 overflow-hidden rounded-md border shadow-sm">
      {options.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          aria-label={label}
          aria-pressed={view === id}
          className={cn(
            "grid size-8 place-items-center border-l p-0 transition-colors first:border-l-0",
            view === id
              ? "bg-primary-soft text-primary"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>
  );
}

export function ListToolbar({
  filters,
  count,
  view,
  onViewChange,
}: {
  filters: FilterSpec[];
  /**
   * What the list amounts to, at the far end of the row — IN THE CALLER'S OWN
   * WORDS. The toolbar counts nothing itself: it serves runs, schedules and
   * packages, and a component that formats "3 runs" for all of them is a
   * component that will one day say it about agents.
   */
  count?: ReactNode;
  /** Present only on the lists the reference draws both as cards and as rows. */
  view?: ListView;
  onViewChange?: (view: ListView) => void;
}) {
  const { t } = useTranslation("common");

  /** Every chosen value, across every dimension: one chip each. */
  const chips = filters.flatMap((filter) =>
    filter.values.map((value) => ({
      key: `${filter.id}:${value}`,
      filter,
      value,
      label: filter.options.find((o) => o.value === value)?.label ?? value,
    })),
  );

  return (
    <div className="mb-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {filters.map((filter) => (
          <FilterMenu key={filter.id} filter={filter} />
        ))}
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {count !== undefined && <span className="text-muted-foreground text-sm">{count}</span>}
          {view && onViewChange && <ViewToggle view={view} onChange={onViewChange} />}
        </div>
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() =>
                chip.filter.onChange(chip.filter.values.filter((v) => v !== chip.value))
              }
              className="border-primary bg-primary-soft text-primary inline-flex items-center gap-1 rounded-full border py-0.5 pr-1.5 pl-2.5 text-xs font-medium"
              aria-label={t("toolbar.removeFilter", {
                filter: chip.filter.label,
                value: chip.label,
              })}
            >
              <span className="max-w-48 truncate">
                {chip.filter.label} : {chip.label}
              </span>
              <X className="size-3 shrink-0 opacity-70" />
            </button>
          ))}
          {chips.length > 1 && (
            <button
              type="button"
              onClick={() => filters.forEach((f) => f.onChange([]))}
              className="text-muted-foreground hover:text-foreground px-1.5 text-xs underline-offset-2 hover:underline"
            >
              {t("toolbar.clearAll")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
