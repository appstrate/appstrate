// SPDX-License-Identifier: Apache-2.0

/**
 * A dropdown menu from `md` up; below, the same items as rows of a panel from the bottom
 * (`SheetMenuContent`): 48 px tall, the same open state, the same `onClick` (the menu closes after
 * it unless the item says `closeOnClick={false}`). A sub-menu is a group of rows there, under its
 * trigger's words. The width picks the container here, once, so no call site does.
 */

import * as React from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { useRender } from "@base-ui/react/use-render";
import { Check, ChevronRight } from "lucide-react";

import { cn } from "../cn.ts";
import { useIsMobile } from "../use-mobile.ts";
import { Sheet, SheetTrigger } from "./sheet.tsx";
import { SHEET_LABEL_CLASS, SHEET_ROW_CLASS, SheetMenuContent } from "./sheet-menu.tsx";
import { splitAnchoring, triggerName, withoutAnchoring } from "./sheet-menu-props.ts";

/** Below `md`: the menu is a sheet, named after its trigger, closed by a selected row. */
interface MenuSheet {
  name: string;
  setName: (name: string) => void;
  close: () => void;
}

const MenuSheetContext = React.createContext<MenuSheet | null>(null);

/** On a sheet, the id of the sub-menu's heading: its rows are a group named by it. */
const SubSheetContext = React.createContext<string | undefined>(undefined);

type WithClassName<P> = Omit<P, "className"> & { className?: string };

interface DropdownMenuProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
  children?: React.ReactNode;
}

function DropdownMenu({ open, defaultOpen, onOpenChange, modal, children }: DropdownMenuProps) {
  const mobile = useIsMobile();
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  const [name, setName] = React.useState("");
  if (!mobile) {
    return (
      <MenuPrimitive.Root
        open={open}
        defaultOpen={defaultOpen}
        onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}
        modal={modal}
      >
        {children}
      </MenuPrimitive.Root>
    );
  }
  const setOpen = (next: boolean) => {
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  return (
    <MenuSheetContext.Provider value={{ name, setName, close: () => setOpen(false) }}>
      <Sheet open={open ?? uncontrolledOpen} onOpenChange={setOpen}>
        {children}
      </Sheet>
    </MenuSheetContext.Provider>
  );
}

function DropdownMenuTrigger({ onClick, ...props }: MenuPrimitive.Trigger.Props) {
  const sheet = React.useContext(MenuSheetContext);
  if (!sheet) return <MenuPrimitive.Trigger onClick={onClick} {...props} />;
  return (
    <SheetTrigger
      onClick={(event) => {
        onClick?.(event);
        sheet.setName(triggerName(event.currentTarget));
      }}
      {...(props as React.ComponentProps<typeof SheetTrigger>)}
    />
  );
}

function DropdownMenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
  const sheet = React.useContext(MenuSheetContext);
  const headingId = React.useId();
  if (!sheet) return <MenuPrimitive.SubmenuRoot {...props} />;
  return <SubSheetContext.Provider value={headingId}>{props.children}</SubSheetContext.Provider>;
}

const DESTRUCTIVE_ITEM =
  "text-destructive focus:bg-destructive/10 focus:text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive";

function DropdownMenuSubTrigger({
  className,
  variant,
  inset,
  children,
  ...props
}: WithClassName<MenuPrimitive.SubmenuTrigger.Props> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  const sheet = React.useContext(MenuSheetContext);
  const headingId = React.useContext(SubSheetContext);
  if (sheet) {
    // The sub-menu's rows follow, under its words: no level to open.
    return (
      <div
        id={headingId}
        className={cn(SHEET_LABEL_CLASS, variant === "destructive" && DESTRUCTIVE_ITEM, className)}
      >
        {children}
      </div>
    );
  }
  return (
    <MenuPrimitive.SubmenuTrigger
      className={cn(
        "data-highlighted:bg-accent data-popup-open:bg-accent flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        inset && "pl-8",
        variant === "destructive" && DESTRUCTIVE_ITEM,
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

const POPUP_CLASS =
  "bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 min-w-[8rem] origin-(--transform-origin) rounded-md border p-1 outline-none";

type MenuContentProps = WithClassName<MenuPrimitive.Popup.Props> &
  Omit<MenuPrimitive.Positioner.Props, "className" | "render" | "style" | "children">;

function DropdownMenuSubContent({ className, ...props }: MenuContentProps) {
  const sheet = React.useContext(MenuSheetContext);
  const headingId = React.useContext(SubSheetContext);
  if (sheet) {
    return (
      <div role="group" aria-labelledby={headingId} className={cn("flex flex-col", className)}>
        {props.children as React.ReactNode}
      </div>
    );
  }
  const [positioning, popup] = splitAnchoring(props);
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner className="z-50" {...positioning}>
        <MenuPrimitive.Popup
          className={cn(POPUP_CLASS, "overflow-hidden shadow-lg", className)}
          {...popup}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  sheetTitle,
  children,
  ...props
}: MenuContentProps & {
  /**
   * The menu's name, drawn as the sheet's heading below `md` (the dropdown has none). Without
   * it the sheet is named after its trigger, for a screen reader only.
   */
  sheetTitle?: string;
}) {
  const sheet = React.useContext(MenuSheetContext);
  if (sheet) {
    return (
      <SheetMenuContent
        title={sheetTitle ?? sheet.name}
        showTitle={sheetTitle !== undefined}
        className={className}
        {...(withoutAnchoring(props) as Omit<
          React.ComponentProps<typeof SheetMenuContent>,
          "title" | "children"
        >)}
      >
        <div className="flex flex-col py-2">{children as React.ReactNode}</div>
      </SheetMenuContent>
    );
  }
  const [positioning, popup] = splitAnchoring(props);
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner className="z-50" sideOffset={sideOffset} {...positioning}>
        <MenuPrimitive.Popup
          className={cn(
            POPUP_CLASS,
            "max-h-(--available-height) overflow-x-hidden overflow-y-auto shadow-md",
            className,
          )}
          {...popup}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

interface SheetRowProps {
  sheet: MenuSheet;
  render?: useRender.RenderProp;
  disabled?: boolean;
  onClick?: React.MouseEventHandler<HTMLElement>;
  closeOnClick?: boolean;
  /** A checkbox item's state: the row says it and flips it. */
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  className?: string;
  children?: React.ReactNode;
  [key: `data-${string}`]: string | undefined;
  "aria-label"?: string;
}

/**
 * An item as a sheet's row: a button (or its `render` element) whose press runs `onClick`, then
 * closes the sheet unless the item says `closeOnClick={false}`, as Base UI's items do (a checkbox
 * item stays open by default). No call site holds an item's ref, so a row takes none.
 */
function SheetRow({
  sheet,
  render,
  disabled,
  onClick,
  closeOnClick,
  checked,
  onCheckedChange,
  className,
  children,
  ...props
}: SheetRowProps) {
  const checkable = checked !== undefined;
  const closes = closeOnClick ?? !checkable;
  return useRender({
    defaultTagName: "button",
    render,
    props: {
      ...props,
      ...(render ? {} : { type: "button" as const, disabled }),
      role: checkable ? "checkbox" : undefined,
      "aria-checked": checkable ? checked : undefined,
      "aria-disabled": disabled || undefined,
      "data-disabled": disabled ? "" : undefined,
      className: cn(SHEET_ROW_CLASS, className),
      onClick: (event: React.MouseEvent<HTMLElement>) => {
        if (disabled) return;
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (checkable) onCheckedChange?.(!checked);
        if (closes) sheet.close();
      },
      children: checkable ? (
        <>
          <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden>
            {checked && <Check />}
          </span>
          {children}
        </>
      ) : (
        children
      ),
    },
  });
}

const ITEM_CLASS =
  "data-highlighted:bg-accent data-highlighted:text-accent-foreground relative flex cursor-default items-center rounded-sm text-sm transition-colors outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50";

function DropdownMenuItem({
  className,
  variant,
  inset,
  ...props
}: WithClassName<MenuPrimitive.Item.Props> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  const sheet = React.useContext(MenuSheetContext);
  if (sheet)
    return (
      <SheetRow
        sheet={sheet}
        className={cn(variant === "destructive" && DESTRUCTIVE_ITEM, className)}
        {...(props as Omit<SheetRowProps, "sheet">)}
      />
    );
  return (
    <MenuPrimitive.Item
      className={cn(
        ITEM_CLASS,
        "gap-2 px-2 py-1.5 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        inset && "pl-8",
        variant === "destructive" && DESTRUCTIVE_ITEM,
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: WithClassName<MenuPrimitive.CheckboxItem.Props>) {
  const sheet = React.useContext(MenuSheetContext);
  if (sheet) {
    return (
      <SheetRow
        sheet={sheet}
        checked={checked ?? false}
        className={className}
        {...(props as Omit<SheetRowProps, "sheet" | "checked">)}
      >
        {children}
      </SheetRow>
    );
  }
  return (
    <MenuPrimitive.CheckboxItem
      className={cn(ITEM_CLASS, "py-1.5 pr-2 pl-8", className)}
      checked={checked}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <MenuPrimitive.CheckboxItemIndicator>
          <Check className="h-4 w-4" />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

/** A heading among the items: words only, not an item (a Base UI group label needs a group). */
function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<"div"> & { inset?: boolean }) {
  const sheet = React.useContext(MenuSheetContext);
  if (sheet) return <div className={cn(SHEET_LABEL_CLASS, className)} {...props} />;
  return (
    <div
      className={cn("px-2 py-1.5 text-sm font-semibold", inset && "pl-8", className)}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: WithClassName<MenuPrimitive.Separator.Props>) {
  const sheet = React.useContext(MenuSheetContext);
  if (sheet) {
    return <div role="separator" className={cn("bg-border my-2 h-px", className)} />;
  }
  return (
    <MenuPrimitive.Separator className={cn("bg-muted -mx-1 my-1 h-px", className)} {...props} />
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
};
