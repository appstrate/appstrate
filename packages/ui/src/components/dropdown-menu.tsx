// SPDX-License-Identifier: Apache-2.0

/**
 * A dropdown menu from `md` up; below, the same items as rows of a panel from the bottom
 * (`SheetMenuContent`): 48 px tall, the same open state, the same `onSelect` (the menu closes after
 * it unless the handler calls `event.preventDefault()`). A sub-menu is a group of rows there, under
 * its trigger's words. The width picks the container here, once, so no call site does.
 */

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Slot } from "@radix-ui/react-slot";
import { Check, ChevronRight } from "lucide-react";

import { cn } from "../cn.ts";
import { useIsMobile } from "../use-mobile.ts";
import { Sheet, SheetTrigger } from "./sheet.tsx";
import { SHEET_LABEL_CLASS, SHEET_ROW_CLASS, SheetMenuContent } from "./sheet-menu.tsx";
import { triggerName, withoutAnchoring } from "./sheet-menu-props.ts";

/** Below `md`: the menu is a sheet, named after its trigger, closed by a selected row. */
interface MenuSheet {
  name: string;
  setName: (name: string) => void;
  close: () => void;
}

const MenuSheetContext = React.createContext<MenuSheet | null>(null);

/** On a sheet, the id of the sub-menu's heading: its rows are a group named by it. */
const SubSheetContext = React.createContext<string | undefined>(undefined);

function DropdownMenu({
  open,
  defaultOpen,
  onOpenChange,
  modal,
  dir,
  children,
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  const mobile = useIsMobile();
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  const [name, setName] = React.useState("");
  if (!mobile) {
    return (
      <DropdownMenuPrimitive.Root
        open={open}
        defaultOpen={defaultOpen}
        onOpenChange={onOpenChange}
        modal={modal}
        dir={dir}
      >
        {children}
      </DropdownMenuPrimitive.Root>
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

const DropdownMenuTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger>
>(({ onClick, ...props }, ref) => {
  const sheet = React.useContext(MenuSheetContext);
  if (!sheet) return <DropdownMenuPrimitive.Trigger ref={ref} onClick={onClick} {...props} />;
  return (
    <SheetTrigger
      ref={ref}
      onClick={(event) => {
        onClick?.(event);
        sheet.setName(triggerName(event.currentTarget));
      }}
      {...props}
    />
  );
});
DropdownMenuTrigger.displayName = DropdownMenuPrimitive.Trigger.displayName;

function DropdownMenuSub(props: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  const sheet = React.useContext(MenuSheetContext);
  const headingId = React.useId();
  if (!sheet) return <DropdownMenuPrimitive.Sub {...props} />;
  return <SubSheetContext.Provider value={headingId}>{props.children}</SubSheetContext.Provider>;
}

const DESTRUCTIVE_ITEM = "text-destructive focus:bg-destructive/10 focus:text-destructive";

const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & {
    inset?: boolean;
    variant?: "default" | "destructive";
  }
>(({ className, variant, inset, children, asChild: _asChild, textValue: _textValue, ...props }, ref) => {
  const sheet = React.useContext(MenuSheetContext);
  const headingId = React.useContext(SubSheetContext);
  if (sheet) {
    // The sub-menu's rows follow, under its words: no level to open.
    const { disabled: _disabled, ...heading } = props;
    return (
      <div ref={ref} id={headingId} className={cn(SHEET_LABEL_CLASS, variant === "destructive" && DESTRUCTIVE_ITEM, className)} {...heading}>
        {children}
      </div>
    );
  }
  return (
    <DropdownMenuPrimitive.SubTrigger
      ref={ref}
      className={cn(
        "focus:bg-accent data-[state=open]:bg-accent flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        inset && "pl-8",
        variant === "destructive" && DESTRUCTIVE_ITEM,
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto" />
    </DropdownMenuPrimitive.SubTrigger>
  );
});
DropdownMenuSubTrigger.displayName = DropdownMenuPrimitive.SubTrigger.displayName;

const DropdownMenuSubContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => {
  const sheet = React.useContext(MenuSheetContext);
  const headingId = React.useContext(SubSheetContext);
  if (sheet) {
    return (
      <div
        ref={ref}
        role="group"
        aria-labelledby={headingId}
        className={cn("flex flex-col", className)}
      >
        {props.children}
      </div>
    );
  }
  return (
    <DropdownMenuPrimitive.SubContent
      ref={ref}
      className={cn(
        "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-md border p-1 shadow-lg",
        className,
      )}
      {...props}
    />
  );
});
DropdownMenuSubContent.displayName = DropdownMenuPrimitive.SubContent.displayName;

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> & {
    /**
     * The menu's name, drawn as the sheet's heading below `md` (the dropdown has none). Without
     * it the sheet is named after its trigger, for a screen reader only.
     */
    sheetTitle?: string;
  }
>(({ className, sideOffset = 4, sheetTitle, children, ...props }, ref) => {
  const sheet = React.useContext(MenuSheetContext);
  if (sheet) {
    return (
      <SheetMenuContent
        ref={ref}
        title={sheetTitle ?? sheet.name}
        showTitle={sheetTitle !== undefined}
        className={className}
        {...withoutAnchoring(props)}
      >
        <div className="flex flex-col py-2">{children}</div>
      </SheetMenuContent>
    );
  }
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-md",
          className,
        )}
        {...props}
      >
        {children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  );
});
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

type SheetRowProps = Omit<
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>,
  "textValue"
> & {
  /** A checkbox item's state: the row says it and flips it. */
  checked?: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>["checked"];
  onCheckedChange?: (checked: boolean) => void;
};

/**
 * An item as a sheet's row: a button (or its `asChild` element) whose press runs `onSelect` with a
 * cancelable event, then closes the sheet unless the handler prevented it, as Radix's items do.
 * No call site holds an item's ref, so a row takes none.
 */
function SheetRow({
  sheet,
  asChild,
  disabled,
  onSelect,
  onClick,
  checked,
  onCheckedChange,
  className,
  children,
  ...props
}: SheetRowProps & { sheet: MenuSheet }) {
  const Comp = (asChild ? Slot : "button") as React.ElementType;
  const checkable = checked !== undefined;
  return (
    <Comp
      {...props}
      {...(asChild ? {} : { type: "button", disabled })}
      role={checkable ? "checkbox" : undefined}
      aria-checked={checkable ? checked === true : undefined}
      aria-disabled={disabled || undefined}
      data-disabled={disabled ? "" : undefined}
      className={cn(SHEET_ROW_CLASS, className)}
      onClick={(event: React.MouseEvent<HTMLElement>) => {
        onClick?.(event as React.MouseEvent<HTMLDivElement>);
        if (event.defaultPrevented || disabled) return;
        const select = new Event("menu.itemSelect", { cancelable: true });
        onSelect?.(select);
        if (checkable) onCheckedChange?.(checked !== true);
        if (!select.defaultPrevented) sheet.close();
      }}
    >
      {checkable ? (
        <>
          <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden>
            {checked === true && <Check />}
          </span>
          {children}
        </>
      ) : (
        children
      )}
    </Comp>
  );
}

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean;
    variant?: "default" | "destructive";
  }
>(({ className, variant, inset, textValue: _textValue, ...props }, ref) => {
  const sheet = React.useContext(MenuSheetContext);
  if (sheet) return <SheetRow sheet={sheet} className={cn(variant === "destructive" && DESTRUCTIVE_ITEM, className)} {...props} />;
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        inset && "pl-8",
        variant === "destructive" && DESTRUCTIVE_ITEM,
        className,
      )}
      {...props}
    />
  );
});
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, checked, textValue: _textValue, ...props }, ref) => {
  const sheet = React.useContext(MenuSheetContext);
  if (sheet) {
    return (
      <SheetRow sheet={sheet} checked={checked ?? false} className={className} {...props}>
        {children}
      </SheetRow>
    );
  }
  return (
    <DropdownMenuPrimitive.CheckboxItem
      ref={ref}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center rounded-sm py-1.5 pr-2 pl-8 text-sm transition-colors outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="h-4 w-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
});
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName;

const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & {
    inset?: boolean;
  }
>(({ className, inset, asChild: _asChild, ...props }, ref) => {
  const sheet = React.useContext(MenuSheetContext);
  if (sheet) return <div ref={ref} className={cn(SHEET_LABEL_CLASS, className)} {...props} />;
  return (
    <DropdownMenuPrimitive.Label
      ref={ref}
      className={cn("px-2 py-1.5 text-sm font-semibold", inset && "pl-8", className)}
      {...props}
    />
  );
});
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, asChild: _asChild, ...props }, ref) => {
  const sheet = React.useContext(MenuSheetContext);
  if (sheet) {
    return (
      <div ref={ref} role="separator" className={cn("bg-border my-2 h-px", className)} {...props} />
    );
  }
  return (
    <DropdownMenuPrimitive.Separator
      ref={ref}
      className={cn("bg-muted -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
});
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;

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
