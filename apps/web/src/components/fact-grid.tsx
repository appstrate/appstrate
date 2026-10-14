// SPDX-License-Identifier: Apache-2.0

/**
 * A label above its value, the one shape every fact sheet uses (run snapshot,
 * schedule parameters, manifest, package overview). `FactGrid` lays facts out
 * in 1 to 4 columns; a `Fact` outside a grid must still sit in a `<dl>`.
 */

import type { ReactNode } from "react";
import { cn } from "@appstrate/ui/cn";

const COLUMNS = {
  1: "grid gap-y-3",
  2: "grid gap-x-8 gap-y-4 sm:grid-cols-2",
  3: "grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4",
} as const;

export function Fact({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
      <dd className="text-foreground mt-1 min-w-0 text-sm break-words whitespace-pre-wrap">
        {children}
      </dd>
    </div>
  );
}

export function FactGrid({
  columns = 2,
  className,
  children,
}: {
  columns?: keyof typeof COLUMNS;
  className?: string;
  children: ReactNode;
}) {
  return <dl className={cn(COLUMNS[columns], className)}>{children}</dl>;
}
