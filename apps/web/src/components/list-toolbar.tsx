// SPDX-License-Identifier: Apache-2.0

/**
 * The bar above a list: what is being filtered, and what you can do to the
 * whole list.
 *
 * The reference calls it `lt-*` and draws it once for every list screen —
 * buttons that open a menu, a count when a filter is on, the active filters
 * repeated underneath as chips you can take off one at a time. Runs wore two
 * stacked tab strips instead, which read as navigation (they were `Tabs`)
 * rather than as filtering, cost a full row each, and could not grow a third
 * dimension without becoming a wall.
 *
 * Two rules it encodes:
 *
 * - **A filter that is on says so twice.** Once on its own button, once as a
 *   chip. The chip is not decoration: it is the only affordance that removes
 *   ONE filter without opening the menu that set it, and it is what makes a
 *   list you did not filter yourself readable at a glance.
 * - **The state belongs in the URL**, not in the component. A filtered list is
 *   the thing people paste to each other ("look at the failed ones") — the
 *   same argument that put settings behind real URLs, and it comes with the
 *   same obligation: Back has to undo a filter, so the caller pushes, never
 *   replaces.
 *
 * What is NOT here: the page's own actions. They have a home — `PageHeader`'s
 * `actions` slot, at title height — and moving one down here would make Runs
 * the only screen whose primary button is not where every other screen's is.
 * The end of the row belongs to what describes the list itself: how many rows
 * the filters left.
 */

import { useTranslation } from "react-i18next";
import { Check, ChevronDown, X } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
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
  /** The chosen value, or undefined when the dimension is not filtered. */
  value?: string;
  options: FilterOption[];
  onChange: (value?: string) => void;
}

function activeLabel(filter: FilterSpec): string | undefined {
  return filter.options.find((o) => o.value === filter.value)?.label;
}

function FilterMenu({ filter }: { filter: FilterSpec }) {
  const { t } = useTranslation("common");
  const active = activeLabel(filter);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        // Whether a filter is on is state, not styling: it rides on an
        // attribute so it can be read without inferring it from a class name.
        data-filtered={active ? "" : undefined}
        className={cn(
          "bg-card inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-sm font-medium shadow-sm transition-colors",
          "hover:bg-accent data-[state=open]:bg-accent",
          active && "border-primary text-primary",
        )}
      >
        {filter.label}
        {active && <span className="text-primary/70 max-w-32 truncate">· {active}</span>}
        <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuLabel>{filter.label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {/* "All" is an option, not the absence of one: a menu whose only way
            back is the chip hides the way back inside another control. */}
        <DropdownMenuItem onSelect={() => filter.onChange(undefined)}>
          <Check className={cn("size-4", filter.value && "invisible")} />
          {t("toolbar.any")}
        </DropdownMenuItem>
        {filter.options.map((option) => (
          <DropdownMenuItem key={option.value} onSelect={() => filter.onChange(option.value)}>
            <Check className={cn("size-4", filter.value !== option.value && "invisible")} />
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ListToolbar({
  filters,
  count,
}: {
  filters: FilterSpec[];
  /** How many rows the filters left, at the far end of the row. */
  count?: number;
}) {
  const { t } = useTranslation("common");
  const active = filters.filter((f) => f.value !== undefined);

  return (
    <div className="mb-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {filters.map((filter) => (
          <FilterMenu key={filter.id} filter={filter} />
        ))}
        {count !== undefined && (
          <span className="text-muted-foreground ml-auto shrink-0 text-sm">
            {t("toolbar.count", { count })}
          </span>
        )}
      </div>

      {active.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {active.map((filter) => (
            <button
              key={filter.id}
              type="button"
              onClick={() => filter.onChange(undefined)}
              className="border-primary bg-primary-soft text-primary inline-flex items-center gap-1 rounded-full border py-0.5 pr-1.5 pl-2.5 text-xs font-medium"
              aria-label={t("toolbar.removeFilter", {
                filter: filter.label,
                value: activeLabel(filter),
              })}
            >
              <span className="max-w-48 truncate">
                {filter.label} : {activeLabel(filter)}
              </span>
              <X className="size-3 shrink-0 opacity-70" />
            </button>
          ))}
          {active.length > 1 && (
            <button
              type="button"
              onClick={() => active.forEach((f) => f.onChange(undefined))}
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
