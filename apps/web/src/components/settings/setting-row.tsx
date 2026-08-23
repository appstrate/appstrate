// SPDX-License-Identifier: Apache-2.0

/**
 * The settings row, in the three shapes the control itself calls for.
 *
 * One shape for every setting in the product, so the answer to "how do I change
 * this" never has to be learned twice. The rule it encodes: **the control IS
 * the setting**. A field you can type in, a dropdown you can open, a toggle you
 * can flip — never a value with an Edit button beside it, which puts two clicks
 * and a mode change between the user and a one-word change.
 *
 * Fields follow their explanation and take a readable line of their own.
 * Toggles sit beside their label. Actions stay opposite their explanation.
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
  variant,
  label,
  description,
  children,
  status,
  className,
}: {
  variant: "field" | "toggle" | "action";
  label: ReactNode;
  description?: ReactNode;
  /** The control. Its kind decides the row's shape. */
  children: ReactNode;
  /** Transient state rendered beside the control, such as a saving spinner. */
  status?: ReactNode;
  className?: string;
}) {
  const copy = (
    <div className="min-w-0">
      <div className="text-sm font-medium">{label}</div>
      {description && <div className="text-muted-foreground mt-0.5 text-sm">{description}</div>}
    </div>
  );

  if (variant === "field") {
    return (
      <div
        data-slot="setting-row"
        data-variant="field"
        className={cn("border-border border-b py-4", className)}
      >
        {copy}
        <div className="mt-3 flex w-full max-w-lg items-center gap-2">
          {children}
          {status}
        </div>
      </div>
    );
  }

  if (variant === "toggle") {
    return (
      <div
        data-slot="setting-row"
        data-variant="toggle"
        className={cn("border-border border-b py-4", className)}
      >
        <div className="flex items-center gap-2">
          {children}
          <div className="text-sm font-medium">{label}</div>
          {status}
        </div>
        {description && <div className="text-muted-foreground mt-1 text-sm">{description}</div>}
      </div>
    );
  }

  return (
    <div
      data-slot="setting-row"
      data-variant="action"
      className={cn(
        "border-border flex items-center justify-between gap-6 border-b py-4",
        className,
      )}
    >
      {copy}
      <div className="flex shrink-0 items-center gap-2">
        {children}
        {status}
      </div>
    </div>
  );
}
