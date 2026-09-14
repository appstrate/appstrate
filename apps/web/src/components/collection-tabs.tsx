// SPDX-License-Identifier: Apache-2.0

/**
 * Tabs that split ONE collection into parts: organisation and space roles,
 * remote and local integrations.
 *
 * Not the tabs of a detail page (`DetailTabsList`), which move between
 * different views of one object. These sit at the head of a list's bar, on the
 * same line as its search and at its height, so the reader sees what part of
 * the collection they are in and how to narrow it in one glance — the view
 * toggle stays at the other end of the same row.
 */
import { Tabs, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";

export interface CollectionTabOption<T extends string> {
  value: T;
  label: string;
  /** How many the part holds, when the screen knows. */
  count?: number;
}

export function CollectionTabs<T extends string>({
  value,
  options,
  label,
  onChange,
}: {
  value: T;
  options: CollectionTabOption<T>[];
  /** Names the tab list for screen readers. */
  label: string;
  onChange: (value: T) => void;
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as T)}>
      <TabsList data-collection-tabs aria-label={label} className="h-8 shrink-0 p-0.5">
        {options.map((option) => (
          <TabsTrigger key={option.value} value={option.value} className="h-7 px-2.5 text-sm">
            {option.label}
            {option.count !== undefined && (
              <span className="text-muted-foreground ml-1.5 text-xs tabular-nums">
                {option.count}
              </span>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
