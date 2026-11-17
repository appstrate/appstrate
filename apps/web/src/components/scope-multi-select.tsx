// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronsUpDown, Check } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@appstrate/ui/components/command";
import { cn } from "@appstrate/ui/cn";
import { permissionLabel, permissionResourceLabel } from "../lib/permission-labels";

/** What the picker calls the things it picks. API keys say "scopes", roles say "permissions". */
interface ScopeMultiSelectLabels {
  all: string;
  none: string;
  count: (count: number) => string;
  search: string;
  empty: string;
}

interface ScopeMultiSelectProps {
  available: string[];
  selected: string[];
  onChange: (scopes: string[]) => void;
  labels?: ScopeMultiSelectLabels;
  /** A note under an entry, such as the action that requires it. */
  hint?: (scope: string) => string | null;
  /** A short mark at the end of an entry, its meaning in `title`: a property, not a sentence. */
  tag?: (scope: string) => { label: string; title: string } | null;
  /** The pending save: the picker cannot be opened. */
  disabled?: boolean;
}

interface ResourceGroup {
  resource: string;
  scopes: string[];
  selectedCount: number;
}

/** Group scopes by resource prefix and compute selection counts. */
function buildGroups(available: string[], selected: string[]): ResourceGroup[] {
  const map = new Map<string, { scopes: string[]; selectedCount: number }>();
  const selectedSet = new Set(selected);

  for (const scope of available) {
    const resource = scope.split(":")[0]!;
    let entry = map.get(resource);
    if (!entry) {
      entry = { scopes: [], selectedCount: 0 };
      map.set(resource, entry);
    }
    entry.scopes.push(scope);
    if (selectedSet.has(scope)) entry.selectedCount++;
  }

  return [...map.entries()].map(([resource, { scopes, selectedCount }]) => ({
    resource,
    scopes,
    selectedCount,
  }));
}

/** The resources a set of scopes reaches, each with how many of its scopes are in. */
export function ScopeSummaryBadges({
  available,
  selected,
}: {
  available: string[];
  selected: string[];
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="flex flex-wrap gap-1">
      {buildGroups(available, selected)
        .filter((g) => g.selectedCount > 0)
        .map((g) => (
          <Badge key={g.resource} variant="secondary" className="px-1.5 py-0 text-[0.65rem]">
            {permissionResourceLabel(g.resource, t)}
            {g.selectedCount < g.scopes.length && (
              <span className="ml-0.5 opacity-60">
                {g.selectedCount}/{g.scopes.length}
              </span>
            )}
          </Badge>
        ))}
    </div>
  );
}

export function ScopeMultiSelect({
  available,
  selected,
  onChange,
  labels,
  hint,
  tag,
  disabled = false,
}: ScopeMultiSelectProps) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => buildGroups(available, selected), [available, selected]);

  // Compare by value, not by count: a length check falsely reports "all
  // selected" when `selected` carries a stale/duplicate scope absent from
  // `available` (same length, different contents).
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const allSelected = available.length > 0 && available.every((s) => selectedSet.has(s));
  const noneSelected = selected.length === 0;

  const toggle = (scope: string) => {
    if (selected.includes(scope)) {
      onChange(selected.filter((s) => s !== scope));
    } else {
      onChange([...selected, scope]);
    }
  };

  const toggleAll = () => {
    onChange(allSelected ? [] : [...available]);
  };

  const text = labels ?? {
    all: t("apiKeys.allScopes"),
    none: t("apiKeys.scopes"),
    count: (count: number) => t("apiKeys.scopeCount", { count }),
    search: t("apiKeys.searchScopes"),
    empty: t("apiKeys.noScopes"),
  };
  const label = allSelected ? text.all : noneSelected ? text.none : text.count(selected.length);

  return (
    <div className="flex flex-col gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="w-full justify-between font-normal"
            disabled={disabled}
          >
            <span className="truncate">{label}</span>
            <ChevronsUpDown className="ml-2 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          <Command>
            <CommandInput placeholder={text.search} />
            <CommandList>
              <CommandEmpty>{text.empty}</CommandEmpty>
              <CommandGroup>
                <CommandItem onSelect={toggleAll}>
                  <Check className={cn("mr-2", allSelected ? "opacity-100" : "opacity-0")} />
                  {allSelected ? t("apiKeys.deselectAll") : t("models.form.discoverSelectAll")}
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
              {groups.map(({ resource, scopes }) => (
                <CommandGroup key={resource} heading={permissionResourceLabel(resource, t)}>
                  {scopes.map((scope) => {
                    const label = permissionLabel(scope, t);
                    const isSelected = selected.includes(scope);
                    const note = hint?.(scope);
                    const mark = tag?.(scope);
                    return (
                      <CommandItem
                        key={scope}
                        value={scope}
                        keywords={[label]}
                        title={scope}
                        onSelect={() => toggle(scope)}
                      >
                        <Check className={cn("mr-2", isSelected ? "opacity-100" : "opacity-0")} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span>{label}</span>
                          {note && <span className="text-muted-foreground text-xs">{note}</span>}
                        </span>
                        {mark && (
                          <Badge
                            variant="outline"
                            className="text-muted-foreground ml-2 shrink-0 font-normal"
                            title={mark.title}
                          >
                            {mark.label}
                          </Badge>
                        )}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {!noneSelected &&
        (allSelected ? (
          <span className="text-muted-foreground text-xs">{t("apiKeys.fullAccess")}</span>
        ) : (
          <ScopeSummaryBadges available={available} selected={selected} />
        ))}
    </div>
  );
}
