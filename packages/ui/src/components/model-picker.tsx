// SPDX-License-Identifier: Apache-2.0

/**
 * The model picker, one for every surface: an agent's Modèle section, a schedule's Exécution, a
 * run with options, and the chat's composer. A Popover + Command list grouped by who pays
 * (`groupModelsForPicker`), searchable when long. A model the person cannot use stays in the
 * list, greyed, with the reason and, when they can fix it themselves, a link.
 *
 * Text and the fix link come from the host (`labels`, `fixLink`): this package knows neither
 * i18n nor a router. `ModelPickerList` alone is the list, for a surface that brings its own
 * popover (the chat's tab); `ModelPicker` is the select-like field.
 */

import type { ReactNode } from "react";
import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "../cn.ts";
import { Badge } from "./badge.tsx";
import { Button } from "./button.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";
import type {
  PickerEntry,
  PickerGroup,
  PickerModel,
  PickerReasonKind,
} from "./model-picker-groups.ts";

export interface ModelPickerLabels {
  kinds: { org: string; personalKey: string; personalSubscription: string; system: string };
  reasons: Record<PickerReasonKind, string>;
  isDefault: string;
  search: string;
  empty: string;
  placeholder: string;
  /** A selected model the list no longer holds. */
  gone: string;
  /** The link that fixes a personal model: « Ajouter votre clé Anthropic → ». */
  fix: (fix: "add" | "reconnect", service: string | null) => string;
}

/** Beyond this many models the list gets a search field. */
const SEARCHABLE_FROM = 8;

const INHERIT = "__inherit__";

function groupTitle(group: PickerGroup, labels: ModelPickerLabels): string {
  const kind =
    group.kind === "org"
      ? labels.kinds.org
      : group.kind === "system"
        ? labels.kinds.system
        : group.subscription
          ? labels.kinds.personalSubscription
          : labels.kinds.personalKey;
  return group.name ? `${group.name} · ${kind}` : kind;
}

function findEntry(groups: readonly PickerGroup[], modelId: string | null): PickerEntry | null {
  if (modelId === null) return null;
  for (const group of groups) {
    const entry = group.entries.find((candidate) => candidate.model.id === modelId);
    if (entry) return entry;
  }
  return null;
}

interface ListProps {
  groups: readonly PickerGroup[];
  /** The selected model id; `null` is the inherit row, when there is one. */
  value: string | null;
  onSelect: (modelId: string | null) => void;
  labels: ModelPickerLabels;
  /** A first row that clears the choice: names what it falls back to. */
  inherit?: { label: string; modelId: string | null };
  renderIcon?: (model: PickerModel) => ReactNode;
  /** The host's link to where the person adds or reconnects a key of their own. */
  fixLink?: (label: string) => ReactNode;
  className?: string;
  listClassName?: string;
}

export function ModelPickerList({
  groups,
  value,
  onSelect,
  labels,
  inherit,
  renderIcon,
  fixLink,
  className,
  listClassName,
}: ListProps) {
  const count = groups.reduce((total, group) => total + group.entries.length, 0);
  const inheritedEntry = inherit ? findEntry(groups, inherit.modelId) : null;
  return (
    <Command className={className}>
      {count >= SEARCHABLE_FROM && <CommandInput placeholder={labels.search} />}
      <CommandList className={listClassName}>
        <CommandEmpty>{labels.empty}</CommandEmpty>
        {inherit && (
          <CommandGroup>
            <CommandItem
              value={INHERIT}
              keywords={[inherit.label]}
              onSelect={() => onSelect(null)}
              className="items-start"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate">{inherit.label}</div>
                {inheritedEntry?.blocked && (
                  <div className="text-muted-foreground text-xs">
                    {labels.reasons[inheritedEntry.blocked]}
                  </div>
                )}
              </div>
              <Check
                className={cn("mt-0.5 size-3.5", value === null ? "opacity-100" : "opacity-0")}
              />
            </CommandItem>
          </CommandGroup>
        )}
        {groups.map((group) => {
          const title = groupTitle(group, labels);
          return (
            <CommandGroup key={group.key} heading={title}>
              {group.needs?.fix && fixLink && (
                <div className="px-2 pb-1 text-xs">
                  {fixLink(labels.fix(group.needs.fix, group.needs.service))}
                </div>
              )}
              {group.entries.map(({ model, isDefault, blocked }) => (
                <CommandItem
                  key={model.id}
                  value={model.id}
                  keywords={[model.label ?? "", title, model.provider_name ?? ""]}
                  disabled={blocked !== null}
                  onSelect={() => onSelect(model.id)}
                  // The reason must stay legible: only the name is greyed.
                  className="items-start data-[disabled=true]:opacity-100"
                >
                  {renderIcon?.(model)}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className={cn("truncate", blocked && "text-muted-foreground")}>
                        {model.label ?? model.modelId}
                      </span>
                      {isDefault && (
                        <Badge variant="secondary" className="px-1.5 py-0 text-[0.65rem]">
                          {labels.isDefault}
                        </Badge>
                      )}
                    </div>
                    {blocked && (
                      <div className="text-muted-foreground text-xs">{labels.reasons[blocked]}</div>
                    )}
                  </div>
                  <Check
                    className={cn(
                      "mt-0.5 size-3.5",
                      model.id === value ? "opacity-100" : "opacity-0",
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          );
        })}
      </CommandList>
    </Command>
  );
}

interface PickerProps extends Omit<ListProps, "className" | "listClassName"> {
  id?: string;
  disabled?: boolean;
}

export function ModelPicker({
  id,
  disabled,
  value,
  onSelect,
  groups,
  labels,
  inherit,
  renderIcon,
  ...list
}: PickerProps) {
  const [open, setOpen] = useState(false);
  const entry = findEntry(groups, value);
  const text =
    value === null
      ? (inherit?.label ?? labels.placeholder)
      : entry
        ? (entry.model.label ?? entry.model.modelId)
        : labels.gone;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="text-foreground w-full justify-between font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            {entry && renderIcon?.(entry.model)}
            <span className="truncate">{text}</span>
            {entry?.blocked && (
              <span className="text-muted-foreground shrink-0 text-xs">
                {labels.reasons[entry.blocked]}
              </span>
            )}
          </span>
          <ChevronsUpDown className="text-muted-foreground size-4 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-72 p-0">
        <ModelPickerList
          groups={groups}
          value={value}
          labels={labels}
          inherit={inherit}
          renderIcon={renderIcon}
          listClassName="max-h-[min(24rem,var(--radix-popover-content-available-height))]"
          {...list}
          onSelect={(modelId) => {
            setOpen(false);
            onSelect(modelId);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
