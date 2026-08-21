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
 *   and it is why the button reads as neutral when nothing is chosen. It is
 *   also why it is `bg-transparent shadow-none`: shadcn's `outline` paints
 *   `bg-background` — WHITE here, since our page canvas is its own `--canvas` —
 *   so the button came out as a white pill on grey and the dashes had nothing
 *   to be dashed against. Their outline does carry a shadow, but a `shadow-xs`
 *   under a solid white button; ours is a `shadow-sm` (one step heavier on
 *   Tailwind 4's scale) and it was falling from a button with nothing in it.
 *   A see-through control casts no shadow.
 * - **The chosen values live INSIDE that button**, as small badges after a
 *   vertical rule: up to two of them, then "N sélectionnés". One place, no
 *   second row, no duplication. When the bar is cramped the names go and a
 *   plain digit stays — a filter then costs a word and a number, which is what
 *   keeps three of them on one line.
 *
 *   That last switch is a CONTAINER query, not a viewport one. shadcn's is
 *   `lg:` because their example IS the page; ours sits to the right of a 256px
 *   sidebar inside a padded column, so a 1440px window leaves the bar about
 *   800px — past `lg`, and out of room. The question is how much space the BAR
 *   has, so the bar is the container.
 * - **The menu is a `Command`**: searchable, square checkboxes, several values
 *   at once, and a centred "Effacer ce filtre" at the bottom — THIS dimension,
 *   which is why it is not called what the row's button is called.
 * - **One "Réinitialiser ✕"** at the end of the row, once anything is filtered:
 *   the only ONE-click way back to the whole list, whatever is on. Everything
 *   else drops one dimension (the menu's own item) or one value (untick it).
 *   It is the CALLER's `onReset`, not a loop over the filters here, and that is
 *   not a style choice: these filters live in the URL, and calling three
 *   `setSearchParams` in one tick makes each of them compute from the same
 *   committed location, so the last one wins and the other two survive. The
 *   button cleared the status and left the scope and the kind exactly where
 *   they were. A reset has to be ONE update, and only the caller knows how to
 *   write it.
 *
 * And what the pattern deliberately does NOT do: write the operators. Values of
 * one dimension are alternatives, dimensions narrow each other — `(statut =
 * échoué OU timeout) ET (type = agent)` — and no faceted filter anywhere spells
 * that out, because the badges sitting inside one button and the buttons
 * sitting side by side already say it.
 *
 * One piece of the original we still cannot have: the per-value counts in the
 * menu. shadcn reads them off the rows it holds
 * (`column.getFacetedUniqueValues()`); ours are paginated server-side, so a
 * count would describe the page rather than the list.
 */

import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, LayoutGrid, PlusCircle, Rows3, SlidersHorizontal, X } from "lucide-react";
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
              <Badge
                variant="secondary"
                className="rounded-sm px-1 font-normal @3xl/filters:hidden"
              >
                {selected.length}
              </Badge>
              <div className="hidden gap-1 @3xl/filters:flex">
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
   * (packages); a list paginated server-side cannot, because the box would
   * search the fifteen rows on screen and call it a search.
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
   * What the screen does, at the right end of the row beside the view controls.
   *
   * On a LIST screen this is where an action belongs, not in `PageHeader` —
   * shadcn puts "Add task" exactly here, and it means every table screen keeps
   * its controls and its actions in the same corner. Screens without a list
   * keep theirs at title height.
   */
  actions?: ReactNode;
}) {
  const { t } = useTranslation("common");
  const isFiltered = filters.some((filter) => filter.values.length > 0);

  return (
    // TWO groups, and only the left one may wrap. With `flex-wrap` on the whole
    // row it was the RIGHT group that went to the next line as soon as a filter
    // grew a badge — the count, the columns, the view and the action all
    // dropping below, which is the one thing that must not move. The left group
    // takes what is left (`flex-1 min-w-0`) and wraps inside its own share;
    // `items-start` keeps the right group on the first line when it does.
    <div className="@container/bar mb-4 flex items-start gap-2">
      {/* Two containers, because the two ends answer different questions: the
          filters shorten against the room THEY have, the right end against the
          room the whole bar has. Named, or the nested one would silently win
          for both. */}
      <div className="@container/filters flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {search && (
          <Input
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
            placeholder={search.placeholder}
            // WHITE, unlike the filters beside it, and the difference is the
            // point: a field is a surface you type into, so it takes the app's
            // component surface like every other input. The filters are
            // see-through because a dashed outline over the canvas is what says
            // "empty slot". Our `Input` is `bg-transparent` by default, which on
            // the grey canvas made the box grey inside.
            className="bg-background h-8 w-[150px] lg:w-[250px]"
          />
        )}
        {filters.map((filter) => (
          <Fragment key={filter.id}>
            <FacetedFilter filter={filter} />
          </Fragment>
        ))}
        {isFiltered && onReset && (
          <Button variant="ghost" size="sm" className="h-8" onClick={onReset}>
            {t("toolbar.reset")}
            <X />
          </Button>
        )}
      </div>

      {/* Never wraps. What it CAN do as the bar narrows is shed what is
          informative before what is operative, in that order: the count goes
          first, then the words on the column menu, then the words on the page's
          own action — which the CALLER writes, using `@…/bar` on its label, so
          the whole row degrades together.
          What does NOT happen here is an overflow menu. shadcn hides its View
          button and keeps "Add task" whole, and that is the right instinct: the
          control a screen exists to offer is the last thing that should need a
          second click to find. */}
      <div className="flex shrink-0 items-center gap-2">
        {count !== undefined && (
          <span className="text-muted-foreground hidden text-sm @2xl/bar:inline">{count}</span>
        )}
        {columns && <ColumnsMenu columns={columns} />}
        {view && onViewChange && <ViewToggle view={view} onChange={onViewChange} />}
        {actions}
      </div>
    </div>
  );
}
