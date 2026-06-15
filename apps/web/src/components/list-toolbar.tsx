// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import {
  Search,
  X,
  SlidersHorizontal,
  ArrowUpDown,
  LayoutGrid,
  List,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type ViewMode = "grid" | "list";

const LT_BTN =
  "border-border bg-card text-foreground hover:bg-accent inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 text-sm font-medium shadow-sm transition-colors data-[state=open]:bg-accent";

/** Card / list view toggle. */
export function ViewToggle({ view, onView }: { view: ViewMode; onView: (v: ViewMode) => void }) {
  const items: [ViewMode, typeof LayoutGrid][] = [
    ["grid", LayoutGrid],
    ["list", List],
  ];
  return (
    <div className="border-border bg-card inline-flex overflow-hidden rounded-[var(--radius-sm)] border shadow-sm">
      {items.map(([v, Icon], i) => (
        <button
          key={v}
          type="button"
          onClick={() => onView(v)}
          className={cn(
            "flex size-8 items-center justify-center transition-colors",
            view === v ? "bg-primary-soft text-primary" : "text-muted-foreground hover:bg-accent",
            i > 0 && "border-border border-l",
          )}
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>
  );
}

export interface FilterOption {
  id: string;
  label: string;
}
export interface FilterGroup {
  label: string;
  options: FilterOption[];
}

/** Faceted filter menu — multi-select checkboxes grouped by facet. */
export function FilterButton({
  groups,
  selected,
  onToggle,
  onReset,
  label,
}: {
  groups: FilterGroup[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onReset: () => void;
  label: string;
}) {
  const count = selected.size;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(LT_BTN, count > 0 && "border-primary text-primary")}>
          <SlidersHorizontal className="size-4" /> {label}
          {count > 0 && (
            <span className="bg-primary text-primary-foreground ml-0.5 flex h-[17px] min-w-[17px] items-center justify-center rounded-full px-1 text-[0.66rem] font-bold">
              {count}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {groups.map((g, gi) => (
          <div key={gi}>
            {gi > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-muted-foreground text-[0.7rem] tracking-wide uppercase">
              {g.label}
            </DropdownMenuLabel>
            {g.options.map((o) => {
              const on = selected.has(o.id);
              return (
                <DropdownMenuItem
                  key={o.id}
                  onSelect={(e) => {
                    e.preventDefault();
                    onToggle(o.id);
                  }}
                  className="gap-2"
                >
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded border",
                      on ? "bg-primary border-primary text-primary-foreground" : "border-border",
                    )}
                  >
                    {on && <Check className="size-3" strokeWidth={3} />}
                  </span>
                  {o.label}
                </DropdownMenuItem>
              );
            })}
          </div>
        ))}
        {count > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onReset} className="gap-2">
              <X className="size-4" /> {label === "Filtrer" ? "Réinitialiser" : label}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface SortOption {
  id: string;
  label: string;
}

/** Sort menu — pick a field + direction. */
export function SortButton({
  options,
  value,
  dir,
  onChange,
  labels,
}: {
  options: SortOption[];
  value: string;
  dir: "asc" | "desc";
  onChange: (id: string, dir: "asc" | "desc") => void;
  labels: { sortBy: string; asc: string; desc: string };
}) {
  const current = options.find((o) => o.id === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={LT_BTN}>
          <ArrowUpDown className="size-4" /> {current?.label ?? labels.sortBy}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        <DropdownMenuLabel className="text-muted-foreground text-[0.7rem] tracking-wide uppercase">
          {labels.sortBy}
        </DropdownMenuLabel>
        {options.map((o) => (
          <DropdownMenuItem key={o.id} onSelect={() => onChange(o.id, dir)} className="gap-2">
            <span className="size-4">
              {value === o.id && <Check className="text-primary size-4" strokeWidth={2.5} />}
            </span>
            {o.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onChange(value, "asc")} className="gap-2">
          <span className="size-4">
            {dir === "asc" && <Check className="text-primary size-4" strokeWidth={2.5} />}
          </span>
          {labels.asc}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onChange(value, "desc")} className="gap-2">
          <span className="size-4">
            {dir === "desc" && <Check className="text-primary size-4" strokeWidth={2.5} />}
          </span>
          {labels.desc}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface ActiveChip {
  key: string;
  label: string;
  onRemove: () => void;
}

/** Unified list toolbar: search + filter + sort + view toggle + active chips. */
export function ListToolbar({
  q,
  onQ,
  placeholder,
  view,
  onView,
  filter,
  sort,
  chips,
}: {
  q?: string;
  onQ?: (v: string) => void;
  placeholder?: string;
  view?: ViewMode;
  onView?: (v: ViewMode) => void;
  filter?: ReactNode;
  sort?: ReactNode;
  chips?: ActiveChip[];
}) {
  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-center gap-2">
        {onQ && (
          <div className="border-border bg-card flex h-9 min-w-[200px] flex-1 items-center gap-2 rounded-[var(--radius-sm)] border px-3 shadow-sm sm:max-w-xs sm:flex-none">
            <Search className="text-muted-foreground size-4 shrink-0" />
            <input
              value={q}
              onChange={(e) => onQ(e.target.value)}
              placeholder={placeholder}
              className="placeholder:text-muted-foreground w-full border-0 bg-transparent p-0 text-sm outline-none focus:ring-0"
            />
            {q && (
              <button
                type="button"
                onClick={() => onQ("")}
                className="text-muted-foreground hover:text-foreground shrink-0"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        )}
        {filter}
        {sort}
        <span className="flex-1" />
        {view && onView && <ViewToggle view={view} onView={onView} />}
      </div>
      {chips && chips.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={c.onRemove}
              className="border-primary bg-primary-soft text-primary inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[0.76rem] font-medium"
            >
              {c.label}
              <X className="size-3 opacity-70" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
