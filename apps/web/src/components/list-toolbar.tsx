// SPDX-License-Identifier: Apache-2.0

/**
 * The bar above a list.
 *
 * The controls are shadcn's, ported from the Tasks example
 * (`apps/v4/app/(app)/examples/tasks/components/` in `shadcn-ui/ui`, live at
 * <https://ui.shadcn.com/examples/tasks>): the faceted filter with its dashed
 * trigger and its `Command` menu, the column menu, the reset. What differs is
 * where the filters LIVE.
 *
 * shadcn keeps them inline in the bar. That works for their example, which is
 * a full-width page with two of them. Ours sit to the right of a 256px sidebar,
 * a screen can have three, and their width depends on how many values are
 * picked and how long the translations run — so the bar spent several rounds
 * either wrapping (flexbox sends the LAST child down, which is the end that
 * must not move) or shedding through a ladder of breakpoints, then measuring
 * itself with a ghost row and a `ResizeObserver` to decide when to fold.
 *
 * All of that is gone. **The filters live behind one button, and open a row of
 * their own** under the bar, where wrapping is not an accident but the point.
 * One layout at every width, nothing to measure.
 *
 * What that costs, and what pays it back:
 *
 * - **A row you asked for is not a row that appeared.** The filters get a
 *   dedicated line that pushes the table down, and they may take two of them.
 * - **The row opens ITSELF when something is filtered.** A list you did not
 *   filter yourself — a link someone sent you — has to say why it is short. An
 *   icon with a badge says "three filters"; the open row says which three.
 * - **The search never moves.** It is the one thing you type into, it stays at
 *   the left of the bar at every width. (It used to travel into the disclosure
 *   row with the filters, which was simply a bug.)
 * - **The right end sheds words before icons** as the bar narrows: the count
 *   goes first, then the labels on the filter and column buttons, then the
 *   label on the page's own action — which the CALLER writes with `@…/bar`, the
 *   container this bar names, so the whole row degrades together. No overflow
 *   menu: shadcn hides its View button and keeps "Add task" whole, and the
 *   control a screen exists to offer is the last thing that should need a
 *   second click to find.
 *
 * Two rules inside the filter menus that were got wrong once each, and are
 * worth keeping written down:
 *
 * - **A tick adds, an untick removes, and nothing else happens.** A version
 *   that also collapsed "every value ticked" to "nothing ticked" was true of
 *   the RESULTS and nonsense as an interaction: Kind has two values, so ticking
 *   the second silently unticked the first, and Scope has one, so its only box
 *   could never stay ticked at all.
 * - **The reset is the CALLER's**, not a loop over the filters here. These
 *   filters live in the URL, and three `setSearchParams` in one tick each
 *   compute from the same committed location: the last wins and the others
 *   survive. The button cleared the status and left the scope and the kind
 *   where they were.
 *
 * And what the pattern deliberately does NOT do: write the operators. Values of
 * one dimension are alternatives, dimensions narrow each other — `(statut =
 * échoué OU timeout) ET (type = agent)` — and no faceted filter anywhere spells
 * that out.
 *
 * One piece of the original we still cannot have: the per-value counts in the
 * menu. shadcn reads them off the rows it holds
 * (`column.getFacetedUniqueValues()`); ours are paginated server-side, so a
 * count would describe the page rather than the list.
 */

import { Fragment, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Filter, LayoutGrid, PlusCircle, Rows3, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import type { ListView } from "@/stores/list-view-store";
import { toggleValue } from "../lib/toggle-value";
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
  DropdownMenuItem,
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
  options: Array<{ id: string; label: string }>;
  hidden: string[];
  onToggle: (id: string) => void;
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
            // `px-2.5 gap-1.5` is what shadcn's own `size="sm"` resolves to for
            // a button carrying an icon (`has-[>svg]:px-2.5`); ours is a flat
            // `px-3 gap-2`, which is where the extra width inside every filter
            // was coming from.
            "h-8 gap-1.5 bg-transparent px-2.5 shadow-none",
            // Dashed AND `+` mean "an empty slot you can fill". Once it is
            // filled the button is not an invitation any more, it is a
            // statement, so both go: the border closes and the plus leaves with
            // it. It also happens to save the width exactly where width is
            // scarce, since a filter with values is the wide one.
            selected.length === 0 && "border-dashed",
          )}
        >
          {selected.length === 0 && <PlusCircle />}
          {filter.label}
          {selected.length > 0 && (
            <>
              <Separator orientation="vertical" className="mx-1.5 h-4" />
              {/* Named while there are few, counted beyond — shadcn's rule, and
                  no breakpoint any more: in a row of their own these buttons
                  may wrap, so they never have to shorten for want of space. */}
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
 * Which columns the reader wants to see, shadcn's `DataTableViewOptions`.
 *
 * A table has more columns than any one person needs at once, and which ones
 * they need is not something the designer can know: the same run list is read
 * for "what broke" (result), for "who ran what" (trigger) and for "how long
 * does this take" (duration). Hiding is per TABLE and remembered, so the choice
 * survives the next visit.
 *
 * The last visible column cannot be hidden — a table with no columns is not a
 * state worth being able to reach.
 */
function ColumnsMenu({ columns }: { columns: ColumnMenuSpec }) {
  const { t } = useTranslation("common");
  const label = t("toolbar.columns");
  const hidden = new Set(columns.hidden);
  const visibleCount = columns.options.filter((option) => !hidden.has(option.id)).length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5" title={label}>
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
            <DropdownMenuItem
              key={option.id}
              disabled={isVisible && visibleCount === 1}
              onSelect={(event) => {
                event.preventDefault();
                columns.onToggle(option.id);
              }}
            >
              <div
                className={cn(
                  "flex size-4 items-center justify-center rounded-[4px] border",
                  isVisible
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input [&_svg]:invisible",
                )}
              >
                <Check className="text-primary-foreground size-3.5" />
              </div>
              <span>{option.label}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
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
  search,
  filters,
  onReset,
  count,
  columns,
  view,
  onViewChange,
  actions,
}: {
  /**
   * The text filter that opens shadcn's own toolbar — present only where the
   * screen can answer it truthfully. A list held whole in the browser can
   * (packages); a list paginated server-side needs an endpoint that searches
   * (runs got a `q`), or the box would search the fifteen rows on screen.
   */
  search?: SearchSpec;
  filters: FilterSpec[];
  /**
   * Clears every dimension in ONE go. Without it there is no reset button —
   * deliberately: a missing reset is visible and harmless, where a reset that
   * loops over the filters looks right and clears only the last one.
   */
  onReset?: () => void;
  /**
   * What the list amounts to, at the far end of the row — IN THE CALLER'S OWN
   * WORDS. The toolbar counts nothing itself: it serves runs, schedules and
   * packages, and a component that formats "3 runs" for all of them is a
   * component that will one day say it about agents.
   */
  count?: ReactNode;
  /** Present on a table whose columns the reader may hide. */
  columns?: ColumnMenuSpec;
  /** Present only on the lists the reference draws both as cards and as rows. */
  view?: ListView;
  onViewChange?: (view: ListView) => void;
  /**
   * What the screen does, at the right end of the row.
   *
   * On a LIST screen this is where an action belongs, not in `PageHeader` —
   * shadcn puts "Add task" exactly here, and it means every table screen keeps
   * its controls and its actions in the same corner. Screens without a list
   * keep theirs at title height.
   */
  actions?: ReactNode;
}) {
  const { t } = useTranslation("common");
  const activeCount = filters.reduce((total, filter) => total + filter.values.length, 0);

  // Open when something is already filtering: a list you did not filter
  // yourself has to say why it is short, and a badge saying "3" does not. Only
  // the FIRST render decides — closing the row afterwards is the reader's call
  // and is not undone by the next keystroke.
  const [open, setOpen] = useState(() => activeCount > 0);

  return (
    <div className="@container/bar mb-4 space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {search && (
            <Input
              value={search.value}
              onChange={(event) => search.onChange(event.target.value)}
              placeholder={search.placeholder}
              // WHITE, unlike the buttons beside it, and the difference is the
              // point: a field is a surface you type into, so it takes the
              // app's component surface like every other input. Our `Input` is
              // `bg-transparent` by default, which on the grey canvas made the
              // box grey inside.
              className="bg-background h-8 w-full max-w-[250px]"
            />
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {count !== undefined && (
            <span className="text-muted-foreground hidden text-sm @2xl/bar:inline">{count}</span>
          )}

          {filters.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              aria-expanded={open}
              title={t("toolbar.filters")}
              className={cn(
                // `px-2.5 gap-1.5` is what shadcn's own `size="sm"` resolves to
                // for a button carrying an icon (`has-[>svg]:px-2.5`); ours is a
                // flat `px-3 gap-2`.
                "h-8 gap-1.5 bg-transparent px-2.5 shadow-none",
                // Dashed means "an empty slot you can fill". Once something is
                // in it the button is a statement, not an invitation.
                activeCount === 0 && "border-dashed",
              )}
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
          {view && onViewChange && <ViewToggle view={view} onChange={onViewChange} />}
          {actions}
        </div>
      </div>

      {/* The filters' own line. It may take two — that is what a dedicated row
          is for, and it is the difference between a line you opened and a line
          that appeared because the window moved. */}
      {open && filters.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {filters.map((filter) => (
            <Fragment key={filter.id}>
              <FacetedFilter filter={filter} />
            </Fragment>
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
