// SPDX-License-Identifier: Apache-2.0

/**
 * A menu as a phone shows it: a panel that rises from the bottom, rows a thumb can hit (48 px), the
 * destructive one in red. The design system's `Sheet`, bottom side, with the rows a menu is made of.
 * A desktop keeps its popovers and dropdown menus; this is for below `md`.
 */

import * as React from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@appstrate/ui/components/sheet";
import { ChevronLeftIcon } from "lucide-react";
import { Switch } from "@appstrate/ui/components/switch";
import { cn } from "@appstrate/ui/cn";

/** A row of a sheet menu: 48 px tall, as wide as the panel. */
export const SHEET_ROW_CLASS =
  "text-foreground flex min-h-12 w-full items-center justify-start gap-3 px-5 py-2 text-left text-base font-normal outline-none transition-colors active:bg-muted focus-visible:bg-muted disabled:opacity-50 [&_svg]:size-5 [&_svg]:shrink-0";

export function SheetMenu({
  open,
  onOpenChange,
  title,
  showTitle = false,
  back,
  header,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The panel's name: its accessible name, drawn as its heading with `showTitle` or `back`. */
  title: string;
  showTitle?: boolean;
  /** A level of a panel that navigates: the way back to the level above it. */
  back?: { label: string; onClick: () => void };
  /** A line shown above the rows, when the rows need saying what they act on. */
  header?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const heading = showTitle || back !== undefined;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        // No drag to dismiss, so no grabber; the bottom inset is the home indicator's, or a margin.
        className={cn(
          "max-h-[85dvh] overflow-y-auto rounded-t-2xl p-0 pb-[max(env(safe-area-inset-bottom),1rem)]",
          className,
        )}
        data-testid="sheet-menu"
      >
        {heading ? (
          <div className="flex min-h-14 items-center gap-1 px-2 pt-2">
            {back && (
              <button
                type="button"
                aria-label={back.label}
                onClick={back.onClick}
                className="text-muted-foreground active:bg-muted focus-visible:bg-muted flex size-11 shrink-0 items-center justify-center rounded-full outline-none"
                data-testid="sheet-menu-back"
              >
                <ChevronLeftIcon className="size-5" aria-hidden />
              </button>
            )}
            <SheetTitle className={cn("truncate text-base font-semibold", !back && "px-3")}>
              {title}
            </SheetTitle>
          </div>
        ) : (
          <SheetTitle className="sr-only">{title}</SheetTitle>
        )}
        <SheetDescription className="sr-only">{title}</SheetDescription>
        {header}
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
