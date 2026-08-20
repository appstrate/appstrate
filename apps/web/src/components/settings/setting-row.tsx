// SPDX-License-Identifier: Apache-2.0

/**
 * The settings row: label and explanation on the left, the control itself on
 * the right.
 *
 * One shape for every setting in the product, so the answer to "how do I change
 * this" never has to be learned twice. The rule it encodes: **the control IS
 * the setting**. A field you can type in, a dropdown you can open, a toggle you
 * can flip — never a value with an Edit button beside it, which puts two clicks
 * and a mode change between the user and a one-word change.
 *
 * Where a change is destructive or needs confirmation, the control is a button
 * that opens a confirm — that is the exception, and it should look like one.
 */
import type { ReactNode } from "react";
import { cn } from "@appstrate/ui/cn";

export function SettingsGroup({
  title,
  children,
  className,
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mb-8", className)}>
      {title && <h4 className="mb-1 text-base font-semibold">{title}</h4>}
      <div className="border-border border-t">{children}</div>
    </section>
  );
}

export function SettingRow({
  label,
  description,
  children,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  /** The control. Rendered right-aligned, and it is the setting itself. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "border-border flex items-center justify-between gap-6 border-b py-4",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {description && <div className="text-muted-foreground mt-0.5 text-sm">{description}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}
