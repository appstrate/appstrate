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
import {
  Check,
  Filter,
  LayoutGrid,
  PlusCircle,
  Rows3,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import type { ListView } from "@/stores/list-view-store";
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
function ColumnsMenu({
  columns,
  iconOnly = false,
}: {
  columns: ColumnMenuSpec;
  iconOnly?: boolean;
}) {
  const { t } = useTranslation("common");
  const label = t("toolbar.columns");
  const hidden = new Set(columns.hidden);
  const visibleCount = columns.options.filter((option) => !hidden.has(option.id)).length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(TOOLBAR_UTILITY, iconOnly && "size-8 px-0")}
          title={label}
          aria-label={label}
        >
          <SlidersHorizontal />
          {!iconOnly && <span className="hidden @xl/bar:inline">{label}</span>}
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
 * Table or cards, for every level-one collection (`view-toggle`). shadcn's
 * slot at this end of the row holds column visibility; ours holds the same
 * kind of thing — how the list is drawn, not what it contains.
 */
function ViewToggle({ view, onChange }: { view: ListView; onChange: (view: ListView) => void }) {
  const { t } = useTranslation("common");
  const options: Array<{ id: ListView; icon: typeof Rows3; label: string }> = [
    { id: "table", icon: Rows3, label: t("toolbar.viewTable") },
    { id: "cards", icon: LayoutGrid, label: t("toolbar.viewCards") },
  ];

  return (
    // A grey track with a white chip on the chosen one — the same segmented
    // control the shell uses for its products, and no colour: the bar has none
    // anywhere else, and a blue fill here read as a state rather than a choice.
    <div className="bg-accent inline-flex shrink-0 gap-0.5 rounded-md p-0.5">
      {options.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          aria-label={label}
          aria-pressed={view === id}
          className={cn(
            "grid size-7 place-items-center rounded-sm p-0 transition-colors",
            view === id
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
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
  columns,
  view,
  onViewChange,
  actions,
  placement = "page",
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
  /** Present on a table whose columns the reader may hide. */
  columns?: ColumnMenuSpec;
  /** Present on every level-one collection, whose two representations are real. */
  view?: ListView;
  onViewChange?: (view: ListView) => void;
  /** Actions for an embedded collection that has no page header of its own. */
  actions?: ReactNode;
  /** A panel keeps its compact, always-visible search instead of page-level responsive chrome. */
  placement?: "page" | "panel";
}) {
  const { t } = useTranslation("common");
  const activeCount = filters.reduce((total, filter) => total + filter.values.length, 0);

  // Open when something is already filtering: a list you did not filter
  // yourself has to say why it is short, and a badge saying "3" does not. Only
  // the FIRST render decides — closing the row afterwards is the reader's call
  // and is not undone by the next keystroke.
  const [open, setOpen] = useState(() => activeCount > 0);
  const [searchOpen, setSearchOpen] = useState(false);

  if (placement === "panel") {
    return (
      <div data-list-toolbar="panel" className="@container/bar mb-4 space-y-2">
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {search && (
              <Input
                value={search.value}
                onChange={(event) => search.onChange(event.target.value)}
                placeholder={search.placeholder}
                className="h-8 w-full max-w-[250px]"
              />
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {filters.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                aria-expanded={open}
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
            {actions}
            {view && onViewChange && <ViewToggle view={view} onChange={onViewChange} />}
          </div>
        </div>

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

  return (
    <div data-list-toolbar="page" className="@container/bar mb-3 space-y-2">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:flex sm:items-center">
        {search && (
          <Input
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
            placeholder={search.placeholder}
            className="hidden h-8 w-full sm:block sm:max-w-[280px]"
          />
        )}

        <div className="flex items-center gap-2 sm:flex-1">
          {search && (
            <Button
              variant="outline"
              size="sm"
              aria-expanded={searchOpen}
              aria-label={search.placeholder}
              title={search.placeholder}
              className={cn(
                TOOLBAR_UTILITY,
                "size-8 px-0 sm:hidden",
                (searchOpen || search.value.trim() !== "") && "bg-accent",
              )}
              onClick={() => setSearchOpen((wasOpen) => !wasOpen)}
            >
              <Search />
            </Button>
          )}

          {filters.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              aria-expanded={open}
              aria-label={t("toolbar.filters")}
              title={t("toolbar.filters")}
              className={cn(TOOLBAR_UTILITY, "aria-expanded:bg-accent relative size-8 px-0")}
              onClick={() => setOpen((wasOpen) => !wasOpen)}
            >
              <Filter />
              {activeCount > 0 && (
                <span className="bg-foreground text-background absolute -top-1 -right-1 grid size-4 place-items-center rounded-full text-[0.6rem] font-semibold">
                  {activeCount}
                </span>
              )}
            </Button>
          )}

          {columns && <ColumnsMenu columns={columns} iconOnly />}
        </div>

        {(actions || (view && onViewChange)) && (
          <div className="flex items-center gap-2 justify-self-end sm:ml-auto">
            {actions}
            {view && onViewChange && <ViewToggle view={view} onChange={onViewChange} />}
          </div>
        )}
      </div>

      {search && searchOpen && (
        <div className="relative sm:hidden">
          <Input
            autoFocus
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setSearchOpen(false);
            }}
            placeholder={search.placeholder}
            className="h-8 w-full pr-9"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("btn.close")}
            title={t("btn.close")}
            className="absolute top-0 right-0 size-8"
            onClick={() => setSearchOpen(false)}
          >
            <X />
          </Button>
        </div>
      )}

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

/**
 * Under the table: what it amounts to, and how to move through it.
 *
 * The count used to sit at the right end of the toolbar. It reads better here,
 * which is also where shadcn keeps it (`data-table-pagination.tsx`, "N row(s)
 * selected" on the left of the page controls): a toolbar is what you act WITH,
 * a footer is what the table came to. It frees the bar's right end for controls
 * as well, which is the end that runs out of room first.
 *
 * Rendered even with one page — the count is the point, the arrows are the
 * option.
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
