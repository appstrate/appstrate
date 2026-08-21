// SPDX-License-Identifier: Apache-2.0

/**
 * The bar above a list, built the way shadcn builds it.
 *
 * This is a port of `DataTableFacetedFilter` + `DataTableToolbar` from the
 * shadcn Tasks example (`apps/v4/app/(app)/examples/tasks/components/`), which
 * is the reference implementation for filtering a table in the design system
 * this app already uses. Two earlier versions of this file were inventions —
 * the value on the trigger AND a chip repeating it below (the same words
 * twice), then chips with "et"/"ou" spelled out between them (a control nobody
 * has ever seen). The convention here is not ours to invent.
 *
 * What the pattern is:
 *
 * - **A dashed outline button per dimension**, with a `+` and the dimension's
 *   name. Dashed and `+` mean "a filter you can add" — that is the affordance,
 *   and it is why the button reads as neutral when nothing is chosen.
 * - **The chosen values live INSIDE that button**, as small badges after a
 *   vertical rule: up to two of them, then "N sélectionnés". One place, no
 *   second row, no duplication.
 * - **The menu is a `Command`**: searchable, square checkboxes, several values
 *   at once, and a centred "Effacer les filtres" at the bottom.
 * - **One "Réinitialiser ✕"** at the end of the row when anything is filtered.
 *
 * And what the pattern deliberately does NOT do: write the operators. Values of
 * one dimension are alternatives, dimensions narrow each other — `(statut =
 * échoué OU timeout) ET (type = agent)` — and no faceted filter anywhere spells
 * that out, because the badges sitting inside one button and the buttons
 * sitting side by side already say it.
 *
 * Two pieces of the original we cannot have yet, both for want of an endpoint:
 * the text search that opens the toolbar (`GET /api/runs` takes no text query)
 * and the per-value counts in the menu (shadcn reads them off the rows it has;
 * ours are paginated server-side, so a count would describe the page rather
 * than the list).
 */

import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, LayoutGrid, PlusCircle, Rows3, X } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import type { ListView } from "@/stores/list-view-store";
import { toggleValue } from "@/lib/toggle-value";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { Separator } from "@appstrate/ui/components/separator";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@appstrate/ui/components/command";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";

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

/** Beyond this many, the button counts instead of naming. */
const NAMED_VALUES = 2;

function FacetedFilter({ filter }: { filter: FilterSpec }) {
  const { t } = useTranslation("common");
  const chosen = new Set(filter.values);
  const selected = filter.options.filter((option) => chosen.has(option.value));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 border-dashed">
          <PlusCircle />
          {filter.label}
          {selected.length > 0 && (
            <>
              <Separator orientation="vertical" className="mx-2 h-4" />
              <Badge variant="secondary" className="rounded-sm px-1 font-normal lg:hidden">
                {selected.length}
              </Badge>
              <div className="hidden gap-1 lg:flex">
                {selected.length > NAMED_VALUES ? (
                  <Badge variant="secondary" className="rounded-sm px-1 font-normal">
                    {t("toolbar.selected", { count: selected.length })}
                  </Badge>
                ) : (
                  selected.map((option) => (
                    <Badge
                      key={option.value}
                      variant="secondary"
                      className="rounded-sm px-1 font-normal"
                    >
                      {option.label}
                    </Badge>
                  ))
                )}
              </div>
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-0" align="start">
        <Command>
          <CommandInput placeholder={filter.label} />
          <CommandList>
            <CommandEmpty>{t("toolbar.noResults")}</CommandEmpty>
            <CommandGroup>
              {filter.options.map((option) => {
                const isSelected = chosen.has(option.value);
                return (
                  <CommandItem
                    key={option.value}
                    onSelect={() => filter.onChange(toggleValue(filter.values, option.value))}
                  >
                    <div
                      className={cn(
                        "flex size-4 items-center justify-center rounded-[4px] border",
                        isSelected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input [&_svg]:invisible",
                      )}
                    >
                      <Check className="text-primary-foreground size-3.5" />
                    </div>
                    <span>{option.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {selected.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    onSelect={() => filter.onChange([])}
                    className="justify-center text-center"
                  >
                    {t("toolbar.clearFilters")}
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Cards or table, for the lists the reference design draws both ways
 * (`view-toggle`). shadcn's slot at this end of the row holds column
 * visibility; ours holds the same kind of thing — how the list is drawn, not
 * what it contains.
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
  const isFiltered = filters.some((filter) => filter.values.length > 0);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {filters.map((filter) => (
        <Fragment key={filter.id}>
          <FacetedFilter filter={filter} />
        </Fragment>
      ))}
      {isFiltered && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8"
          onClick={() => filters.forEach((filter) => filter.onChange([]))}
        >
          {t("toolbar.reset")}
          <X />
        </Button>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-3">
        {count !== undefined && <span className="text-muted-foreground text-sm">{count}</span>}
        {view && onViewChange && <ViewToggle view={view} onChange={onViewChange} />}
      </div>
    </div>
  );
}
