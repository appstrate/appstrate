// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronsUpDown, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

interface ScopeMultiSelectProps {
  available: string[];
  selected: string[];
  onChange: (scopes: string[]) => void;
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

export function ScopeMultiSelect({ available, selected, onChange }: ScopeMultiSelectProps) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => buildGroups(available, selected), [available, selected]);

  const allSelected = selected.length === available.length;
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

  const label = allSelected
    ? t("apiKeys.allScopes")
    : noneSelected
      ? t("apiKeys.scopes")
      : t("apiKeys.scopeCount", { count: selected.length });

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="w-full justify-between font-normal">
            <span className="truncate">{label}</span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          <Command>
            <CommandInput placeholder={t("apiKeys.searchScopes")} />
            <CommandList>
              <CommandEmpty>{t("apiKeys.noScopes")}</CommandEmpty>
              <CommandGroup>
                <CommandItem onSelect={toggleAll}>
                  <Check
                    className={cn("mr-2 h-4 w-4", allSelected ? "opacity-100" : "opacity-0")}
                  />
                  {allSelected ? t("apiKeys.deselectAll") : t("apiKeys.selectAll")}
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
              {groups.map(({ resource, scopes }) => (
                <CommandGroup key={resource} heading={resource}>
                  {scopes.map((scope) => {
                    const action = scope.split(":")[1]!;
                    const isSelected = selected.includes(scope);
                    return (
                      <CommandItem key={scope} value={scope} onSelect={() => toggle(scope)}>
                        <Check
                          className={cn("mr-2 h-4 w-4", isSelected ? "opacity-100" : "opacity-0")}
                        />
                        {action}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {/* Resource summary badges */}
      {!noneSelected && (
        <div className="flex flex-wrap gap-1">
          {allSelected ? (
            <span className="text-muted-foreground text-xs">{t("apiKeys.fullAccess")}</span>
          ) : (
            groups
              .filter((g) => g.selectedCount > 0)
              .map((g) => (
                <Badge key={g.resource} variant="secondary" className="px-1.5 py-0 text-[0.65rem]">
                  {g.resource}
                  {g.selectedCount < g.scopes.length && (
                    <span className="ml-0.5 opacity-60">
                      {g.selectedCount}/{g.scopes.length}
                    </span>
                  )}
                </Badge>
              ))
          )}
        </div>
      )}
    </div>
  );
}
