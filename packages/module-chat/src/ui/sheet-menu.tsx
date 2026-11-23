// SPDX-License-Identifier: Apache-2.0

/**
 * A menu as a phone shows it: a panel that rises from the bottom, rows a thumb can hit (48 px), the
 * destructive one in red. The design system's `Sheet`, bottom side, with the rows a menu is made of.
 * Below `md`; from `md` up the same rows sit in a popover, dense under a mouse (`desktop-pointer:`).
 */

import * as React from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@appstrate/ui/components/sheet";
import { ChevronLeftIcon } from "lucide-react";
import { Switch } from "@appstrate/ui/components/switch";
import { cn } from "@appstrate/ui/cn";
import { MOBILE_MEDIA_QUERY } from "@appstrate/ui/use-mobile";

/**
 * The width decides the container, read when a menu opens: below `md` (48rem, the `md` of
 * styles.css) a sheet from the bottom, from `md` up a popover or a dropdown.
 */
export function opensAsSheet(): boolean {
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

/**
 * A row's inset, the way a dropdown's items sit: a margin off the panel's edges and a rounded
 * shape, so its hover and press backgrounds read as the row rather than a band across the panel.
 * Margin plus inner padding put its text where the heading's, the hints' and the disclaimer's sit
 * (20 px on touch, 12 px under a mouse). Rows stretch in their flex column, so no `w-full`.
 */
const ROW_INSET_CLASS =
  "mx-2 rounded-lg px-3 desktop-pointer:mx-1 desktop-pointer:rounded-md desktop-pointer:px-2";

/** A row of a sheet menu: 48 px tall, inset from the panel's edges. */
export const SHEET_ROW_CLASS = `${ROW_INSET_CLASS} text-foreground flex min-h-12 items-center justify-start gap-3 py-2 text-left text-base font-normal outline-none transition-colors active:bg-muted focus-visible:bg-muted hover:bg-muted disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-5 [&_svg]:shrink-0 desktop-pointer:min-h-9 desktop-pointer:gap-2 desktop-pointer:py-1.5 desktop-pointer:text-sm desktop-pointer:[&_svg]:size-4`;

/** A level of a panel that navigates: the way back to the level above it. */
export interface MenuBack {
  label: string;
  onClick: () => void;
}

/**
 * A panel's heading: the way back to the level above, then the level's name (`children`, the
 * container's own title element: a sheet's `SheetTitle`, a popover's labelled paragraph).
 */
export function MenuHeading({ back, children }: { back?: MenuBack; children: React.ReactNode }) {
  return (
    <div className="desktop-pointer:min-h-10 desktop-pointer:px-1 desktop-pointer:pt-1 flex min-h-14 items-center gap-1 px-2 pt-2">
      {back && (
        <button
          type="button"
          aria-label={back.label}
          onClick={back.onClick}
          className="text-muted-foreground active:bg-muted focus-visible:bg-muted hover:bg-muted desktop-pointer:size-8 flex size-11 shrink-0 items-center justify-center rounded-full outline-none"
          data-testid="sheet-menu-back"
        >
          <ChevronLeftIcon className="desktop-pointer:size-4 size-5" aria-hidden />
        </button>
      )}
      <div className={cn("min-w-0 flex-1", !back && "desktop-pointer:px-2 px-3")}>{children}</div>
    </div>
  );
}

/** A level's name, as {@link MenuHeading} draws it. */
export const MENU_TITLE_CLASS = "truncate text-base font-semibold desktop-pointer:text-sm";

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
  /** A level of a panel that navigates: the way back to the level above it (Escape takes it too). */
  back?: MenuBack;
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
        // A level goes up one level on Escape; the top level closes.
        onEscapeKeyDown={(event) => {
          if (!back) return;
          event.preventDefault();
          back.onClick();
        }}
      >
        {heading ? (
          <MenuHeading back={back}>
            <SheetTitle className={MENU_TITLE_CLASS}>{title}</SheetTitle>
          </MenuHeading>
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
  testId,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  icon?: React.ReactNode;
  label: React.ReactNode;
  hint?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      className={cn(
        ROW_INSET_CLASS,
        "desktop-pointer:min-h-9 desktop-pointer:gap-2 desktop-pointer:py-1.5 desktop-pointer:[&_svg]:size-4 flex min-h-12 items-center gap-3 py-2 [&_svg]:size-5 [&_svg]:shrink-0",
      )}
    >
      {icon}
      <label
        htmlFor={id}
        className="text-foreground desktop-pointer:text-sm flex min-w-0 flex-1 flex-col text-base"
      >
        {label}
        {hint && (
          <span className="text-muted-foreground desktop-pointer:text-xs text-sm">{hint}</span>
        )}
      </label>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        data-testid={testId}
      />
    </div>
  );
}
