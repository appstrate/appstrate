// SPDX-License-Identifier: Apache-2.0

/**
 * A menu as a phone shows it: a panel that rises from the bottom, rows a thumb can hit (48 px), the
 * destructive one in red. The bottom `Sheet`, with the rows a menu is made of.
 *
 * `DropdownMenu` and `Popover` draw their content with it below `md` on their own: a call site
 * never chooses the container. The rows are also for a panel's own content (the chat composer's
 * tools), dense under a mouse (`desktop-pointer:`) when that panel sits in a popover.
 */

import * as React from "react";
import { ChevronLeftIcon } from "lucide-react";

import { cn } from "../cn.ts";
import { SheetContent, SheetTitle } from "./sheet.tsx";
import { Switch } from "./switch.tsx";

/**
 * A row's inset, the way a dropdown's items sit: a margin off the panel's edges and a rounded
 * shape, so its hover and press backgrounds read as the row rather than a band across the panel.
 * Margin plus inner padding put its text where the heading's and the labels' sit (20 px on touch,
 * 12 px under a mouse). Rows stretch in their flex column, so no `w-full`.
 */
const ROW_INSET_CLASS =
  "mx-2 rounded-lg px-3 desktop-pointer:mx-1 desktop-pointer:rounded-md desktop-pointer:px-2";

/** A row's box: 48 px on touch, its icon at 20 px; a mouse's row is denser. */
const ROW_BOX_CLASS = `${ROW_INSET_CLASS} flex min-h-12 items-center gap-3 py-2 [&_svg]:size-5 [&_svg]:shrink-0 desktop-pointer:min-h-9 desktop-pointer:gap-2 desktop-pointer:py-1.5 desktop-pointer:[&_svg]:size-4`;

export const SHEET_ROW_CLASS = `${ROW_BOX_CLASS} text-foreground justify-start text-left text-base font-normal outline-none transition-colors active:bg-muted focus-visible:bg-muted hover:bg-muted disabled:pointer-events-none disabled:opacity-50 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 desktop-pointer:text-sm`;

/** A line naming a group of rows, inset like their text. */
export const SHEET_LABEL_CLASS =
  "text-muted-foreground flex items-center gap-2 px-5 pt-3 pb-1 text-sm font-medium [&_svg]:size-4 [&_svg]:shrink-0 desktop-pointer:px-3 desktop-pointer:text-xs";

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

interface SheetMenuContentProps extends Omit<
  React.ComponentPropsWithoutRef<typeof SheetContent>,
  "side" | "showCloseButton" | "title"
> {
  /** The panel's name: its accessible name, drawn as its heading with `showTitle`. */
  title: string;
  showTitle?: boolean;
}

/**
 * A sheet menu's panel, inside a `Sheet` root: from the bottom, at most 85 % of the screen, its
 * rows scrolling. A width or a height the call site set for a popover yields to the screen's.
 */
export const SheetMenuContent = React.forwardRef<HTMLDivElement, SheetMenuContentProps>(
  ({ title, showTitle = false, className, children, ...props }, ref) => (
    <SheetContent
      ref={ref}
      side="bottom"
      showCloseButton={false}
      // The title names the panel; there is no description to read after it.
      aria-describedby={undefined}
      data-testid="sheet-menu"
      {...props}
      // No drag to dismiss, so no grabber; the bottom inset is the home indicator's, or a margin.
      className={cn(
        "gap-0 overflow-y-auto p-0",
        className,
        "max-h-[85dvh] w-full max-w-none min-w-0 rounded-t-2xl pb-[max(env(safe-area-inset-bottom),1rem)]",
      )}
    >
      {showTitle ? (
        <MenuHeading>
          <SheetTitle className={MENU_TITLE_CLASS}>{title}</SheetTitle>
        </MenuHeading>
      ) : (
        <SheetTitle className="sr-only">{title}</SheetTitle>
      )}
      {children}
    </SheetContent>
  ),
);
SheetMenuContent.displayName = "SheetMenuContent";

export const SheetMenuRow = React.forwardRef<HTMLButtonElement, React.ComponentProps<"button">>(
  ({ className, type = "button", ...props }, ref) => (
    <button ref={ref} type={type} className={cn(SHEET_ROW_CLASS, className)} {...props} />
  ),
);
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
    <div className={ROW_BOX_CLASS}>
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
