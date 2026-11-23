// SPDX-License-Identifier: Apache-2.0

/**
 * A popover from `md` up; below, the same content in a panel from the bottom (`SheetMenuContent`),
 * with the same open state. The width picks the container here, once, so no call site does.
 */

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "../cn.ts";
import { useIsMobile } from "../use-mobile.ts";
import { Sheet, SheetTrigger } from "./sheet.tsx";
import { SheetMenuContent } from "./sheet-menu.tsx";
import { triggerName, withoutAnchoring } from "./sheet-menu-props.ts";

/** Below `md`: the popover is a sheet, and its accessible name is its trigger's. */
interface PopoverSheet {
  name: string;
  setName: (name: string) => void;
}

const PopoverSheetContext = React.createContext<PopoverSheet | null>(null);

function Popover({
  open,
  defaultOpen,
  onOpenChange,
  modal,
  children,
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const mobile = useIsMobile();
  const [name, setName] = React.useState("");
  if (!mobile) {
    return (
      <PopoverPrimitive.Root
        open={open}
        defaultOpen={defaultOpen}
        onOpenChange={onOpenChange}
        modal={modal}
      >
        {children}
      </PopoverPrimitive.Root>
    );
  }
  return (
    <PopoverSheetContext.Provider value={{ name, setName }}>
      <Sheet open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
        {children}
      </Sheet>
    </PopoverSheetContext.Provider>
  );
}

const PopoverTrigger = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>
>(({ onClick, ...props }, ref) => {
  const sheet = React.useContext(PopoverSheetContext);
  if (!sheet) return <PopoverPrimitive.Trigger ref={ref} onClick={onClick} {...props} />;
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
PopoverTrigger.displayName = PopoverPrimitive.Trigger.displayName;

/** The element the popover lines up with; a sheet lines up with the screen, so it is just itself. */
const PopoverAnchor = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Anchor>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Anchor>
>(({ asChild, ...props }, ref) => {
  const sheet = React.useContext(PopoverSheetContext);
  if (!sheet) return <PopoverPrimitive.Anchor ref={ref} asChild={asChild} {...props} />;
  const Comp = asChild ? Slot : "div";
  return <Comp ref={ref} {...props} />;
});
PopoverAnchor.displayName = PopoverPrimitive.Anchor.displayName;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => {
  const sheet = React.useContext(PopoverSheetContext);
  if (sheet) {
    return (
      <SheetMenuContent
        ref={ref}
        title={sheet.name}
        className={cn("p-4", className)}
        {...withoutAnchoring(props)}
      />
    );
  }
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border p-4 shadow-md outline-none",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
});
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent };
