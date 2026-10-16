// SPDX-License-Identifier: Apache-2.0

/**
 * The bar above a list. The controls are shadcn's, ported from the Tasks example
 * (`apps/v4/app/(app)/examples/tasks/components/` in `shadcn-ui/ui`): the faceted filter with
 * its dashed trigger and `Command` menu, the column menu, the reset.
 *
 * Where they differ: the filters live behind ONE button and open a row of their own under the
 * bar. Ours sit right of a 256px sidebar, a screen can have three, and their width depends on how
 * many values are picked, so an inline bar would have to wrap, shed through breakpoints or
 * measure itself. A disclosure row wraps on purpose and needs no measuring.
 *
 * - **The row opens ITSELF when something is filtered.** A list you did not filter yourself (a
 *   link someone sent you) has to say why it is short; the badge says "3", the row says which.
 * - **A tick adds, an untick removes, and nothing else happens** (`lib/toggle-value.ts`).
 * - **The reset is the CALLER's.** These filters live in the URL, and several `setSearchParams`
 *   in one tick each compute from the same committed location: the last wins, so a loop here
 *   would clear one filter and leave the rest.
 * - **One layout at every width.** The bar wraps; the buttons shed their words before their
 *   icons as the `@container/bar` narrows, and the callers' own action labels follow it.
 * - **No per-value counts in the menu.** Ours are paginated server-side, so a count would
 *   describe the page rather than the list.
 */

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Filter, PlusCircle, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { toggleValue } from "../lib/toggle-value";
import { TOOLBAR_UTILITY } from "../lib/toolbar-button";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";

export interface FilterOption {
  value: string;
  label: string;
}

/** What the "Colonnes" menu needs: what there is, what is hidden, how to flip one. */
export interface ColumnMenuSpec {
  options: Array<{ id: string; label: string; required?: boolean }>;
  hidden: string[];
  onToggle: (id: string) => void;
  dirty?: boolean;
  onSave?: () => void;
  onDiscard?: () => void;
}

export interface SearchSpec {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
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
        <Button
          variant="outline"
          size="sm"
          className={cn(
            // shadcn's own `size="sm"` resolves to `px-2.5 gap-1.5` for a button carrying an
            // icon; ours is a flat `px-3 gap-2`, which would add width inside every filter.
            "h-8 gap-1.5 bg-transparent px-2.5 shadow-none",
            // Dashed and `+` both mean "an empty slot you can fill"; a filled button is a
            // statement, so the border closes and the plus leaves with it.
            selected.length === 0 && "border-dashed",
          )}
        >
          {selected.length === 0 && <PlusCircle />}
          {filter.label}
          {selected.length > 0 && (
            <>
              <Separator orientation="vertical" className="mx-1.5 h-4" />
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
 * Which columns the reader wants to see (shadcn's `DataTableViewOptions`), per TABLE and
 * remembered. The last visible column cannot be hidden: a table with no columns is not a state
 * worth being able to reach.
 */
function ColumnsMenu({ columns }: { columns: ColumnMenuSpec }) {
  const { t } = useTranslation("common");
  const label = t("toolbar.columns");
  const hidden = new Set(columns.hidden);
  const visibleCount = columns.options.filter((option) => !hidden.has(option.id)).length;

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) columns.onDiscard?.();
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={TOOLBAR_UTILITY}
          title={label}
          aria-label={label}
        >
          <SlidersHorizontal />
          <span className="hidden @xl/bar:inline">{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>{t("toolbar.columnsLabel")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {columns.options.map((option) => {
          const isVisible = !hidden.has(option.id);
          return (
            <DropdownMenuCheckboxItem
              key={option.id}
              checked={isVisible}
              disabled={option.required || (isVisible && visibleCount === 1)}
              onCheckedChange={() => columns.onToggle(option.id)}
              // Stay open: several columns are usually toggled in a row.
              onSelect={(event) => event.preventDefault()}
            >
              {option.label}
            </DropdownMenuCheckboxItem>
          );
        })}
        {columns.dirty && (
          <div className="flex justify-end gap-2 border-t p-2">
            <Button type="button" size="sm" variant="ghost" onClick={columns.onDiscard}>
              {t("btn.cancel")}
            </Button>
            <Button type="button" size="sm" onClick={columns.onSave}>
              {t("btn.save")}
            </Button>
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const NO_FILTERS: FilterSpec[] = [];

export function ListToolbar({
  search,
  filters = NO_FILTERS,
  onReset,
  columns,
  actions,
  tabs,
}: {
  /**
   * The text filter — present only where the screen can answer it truthfully. A list held whole
   * in the browser can; a list paginated server-side needs an endpoint that searches, or the
   * box would search the fifteen rows on screen.
   */
  search?: SearchSpec;
  /** Absent on a list that only searches. */
  filters?: FilterSpec[];
  /**
   * Clears every dimension in ONE go. Without it there is no reset button — deliberately: a
   * missing reset is visible and harmless, where a looping one clears only the last filter.
   */
  onReset?: () => void;
  /** Present on a table whose columns the reader may hide. */
  columns?: ColumnMenuSpec;
  /** The page's own action, at the right end of the bar. */
  actions?: ReactNode;
  /** `CollectionTabs` splitting the list, drawn first on the bar's line. */
  tabs?: ReactNode;
}) {
  const { t } = useTranslation("common");
  const activeCount = filters.reduce((total, filter) => total + filter.values.length, 0);

  // Only the FIRST render decides: closing the row afterwards is the reader's call and is not
  // undone by the next keystroke.
  const [open, setOpen] = useState(() => activeCount > 0);

  return (
    <div className="@container/bar mb-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {tabs}
        {search && (
          <Input
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
            placeholder={search.placeholder}
            className="[[data-slot=dialog-content]_&]:bg-background h-8 min-w-40 flex-1 sm:max-w-[280px]"
          />
        )}
        {filters.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            aria-expanded={open}
            aria-label={t("toolbar.filters")}
            title={t("toolbar.filters")}
            className={cn(TOOLBAR_UTILITY, "aria-expanded:bg-accent")}
            onClick={() => setOpen((wasOpen) => !wasOpen)}
          >
            <Filter />
            <span className="hidden @xl/bar:inline">{t("toolbar.filters")}</span>
            {activeCount > 0 && (
              <Badge variant="secondary" className="rounded-sm px-1 font-normal">
                {activeCount}
              </Badge>
            )}
          </Button>
        )}
        {columns && <ColumnsMenu columns={columns} />}
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>

      {open && filters.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {filters.map((filter) => (
            <FacetedFilter key={filter.id} filter={filter} />
          ))}
          {activeCount > 0 && onReset && (
            <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2.5" onClick={onReset}>
              <X />
              {t("toolbar.reset")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Under the table: what it amounts to, and how to move through it. A toolbar is what you act
 * WITH, a footer is what the table came to (shadcn's pagination row keeps the count on the left
 * too). Rendered even with one page — the count is the point, the arrows are the option.
 */
export function ListFooter({ count, children }: { count?: ReactNode; children?: ReactNode }) {
  if (count === undefined && !children) return null;
  return (
    <div className="text-muted-foreground mt-3 flex items-center justify-between gap-4 text-sm">
      <span className="min-w-0 truncate">{count}</span>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}
