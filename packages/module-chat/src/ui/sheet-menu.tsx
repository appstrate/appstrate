// SPDX-License-Identifier: Apache-2.0

/**
 * A menu as a phone shows it: a panel that rises from the bottom, rows a thumb can hit (48 px), the
 * destructive one in red. The design system's `Sheet`, bottom side, with the rows a menu is made of.
 * A desktop keeps its popovers and dropdown menus; this is for below `md`.
 */

import * as React from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@appstrate/ui/components/sheet";
import { Switch } from "@appstrate/ui/components/switch";
import { cn } from "@appstrate/ui/cn";

/** A row of a sheet menu: 48 px tall, as wide as the panel. */
export const SHEET_ROW_CLASS =
  "text-foreground flex min-h-12 w-full items-center justify-start gap-3 px-5 py-2 text-left text-base font-normal outline-none transition-colors active:bg-muted focus-visible:bg-muted disabled:opacity-50 [&_svg]:size-5 [&_svg]:shrink-0";

export function SheetMenu({
  open,
  onOpenChange,
  title,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The panel's accessible name (it draws no title of its own). */
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className={cn(
          "max-h-[85dvh] overflow-y-auto rounded-t-2xl p-0 pb-[env(safe-area-inset-bottom)]",
          className,
        )}
        data-testid="sheet-menu"
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        <SheetDescription className="sr-only">{title}</SheetDescription>
        {/* The grabber says it is a panel one can drag away, as on every phone. */}
        <div aria-hidden className="bg-border mx-auto mt-2 h-1 w-9 rounded-full" />
        <div className="flex flex-col py-2">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

export const SheetMenuRow = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & { destructive?: boolean }
>(({ className, destructive, type = "button", ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(SHEET_ROW_CLASS, destructive && "text-destructive", className)}
    {...props}
  />
));
SheetMenuRow.displayName = "SheetMenuRow";

/** A setting that is on or off: the label, then the switch, the whole row toggles. */
export function SheetMenuSwitchRow({
  id,
  checked,
  onCheckedChange,
  disabled,
  icon,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  icon?: React.ReactNode;
  label: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-12 items-center gap-3 px-5 py-2 [&_svg]:size-5 [&_svg]:shrink-0">
      {icon}
      <label htmlFor={id} className="text-foreground flex min-w-0 flex-1 flex-col text-base">
        {label}
        {hint && <span className="text-muted-foreground text-sm">{hint}</span>}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}
