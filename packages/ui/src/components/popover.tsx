// SPDX-License-Identifier: Apache-2.0

/**
 * A popover from `md` up; below, the same content in a panel from the bottom (`SheetMenuContent`),
 * with the same open state. The width picks the container here, once, so no call site does.
 */

import * as React from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useRender } from "@base-ui/react/use-render";

import { cn } from "../cn.ts";
import { useIsMobile } from "../use-mobile.ts";
import { Sheet, SheetTrigger } from "./sheet.tsx";
import { SheetMenuContent } from "./sheet-menu.tsx";
import { splitAnchoring, triggerName, withoutAnchoring } from "./sheet-menu-props.ts";

/** Below `md`: the popover is a sheet, and its accessible name is its trigger's. */
interface PopoverSheet {
  name: string;
  setName: (name: string) => void;
}

const PopoverSheetContext = React.createContext<PopoverSheet | null>(null);

/** From `md` up: the element a `PopoverAnchor` drew, which the content lines up with. */
interface PopoverAnchoring {
  anchor: Element | null;
  setAnchor: (element: Element | null) => void;
}

const PopoverAnchorContext = React.createContext<PopoverAnchoring | null>(null);

function Popover({
  open,
  defaultOpen,
  onOpenChange,
  modal,
  children,
}: PopoverPrimitive.Root.Props) {
  const mobile = useIsMobile();
  const [name, setName] = React.useState("");
  const [anchor, setAnchor] = React.useState<Element | null>(null);
  if (!mobile) {
    return (
      <PopoverAnchorContext.Provider value={{ anchor, setAnchor }}>
        <PopoverPrimitive.Root
          open={open}
          defaultOpen={defaultOpen}
          onOpenChange={onOpenChange}
          modal={modal}
        >
          {children}
        </PopoverPrimitive.Root>
      </PopoverAnchorContext.Provider>
    );
  }
  return (
    <PopoverSheetContext.Provider value={{ name, setName }}>
      <Sheet
        open={open}
        defaultOpen={defaultOpen}
        // A sheet's reasons are a subset of a popover's (escape, outside press, close press).
        onOpenChange={(next, details) =>
          onOpenChange?.(next, details as unknown as PopoverPrimitive.Root.ChangeEventDetails)
        }
      >
        {children as React.ReactNode}
      </Sheet>
    </PopoverSheetContext.Provider>
  );
}

function PopoverTrigger({ onClick, ...props }: PopoverPrimitive.Trigger.Props) {
  const sheet = React.useContext(PopoverSheetContext);
  if (!sheet) return <PopoverPrimitive.Trigger onClick={onClick} {...props} />;
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

/** The element the popover lines up with; a sheet lines up with the screen, so it is just itself. */
function PopoverAnchor({ render, ref, ...props }: useRender.ComponentProps<"div">) {
  const anchoring = React.useContext(PopoverAnchorContext);
  return useRender({
    defaultTagName: "div",
    render,
    ref: anchoring ? (ref ? [ref, anchoring.setAnchor] : anchoring.setAnchor) : ref,
    props,
  });
}

type PopoverContentProps = Omit<PopoverPrimitive.Popup.Props, "className"> &
  Omit<PopoverPrimitive.Positioner.Props, "className" | "render" | "style" | "children"> & {
    className?: string;
  };

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: PopoverContentProps) {
  const sheet = React.useContext(PopoverSheetContext);
  const anchoring = React.useContext(PopoverAnchorContext);
  if (sheet) {
    return (
      <SheetMenuContent
        {...(withoutAnchoring(props) as React.ComponentProps<typeof SheetMenuContent>)}
        title={sheet.name}
        className={cn("p-4", className)}
      />
    );
  }
  const [positioning, popup] = splitAnchoring(props);
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        sideOffset={sideOffset}
        anchor={anchoring?.anchor ?? undefined}
        {...positioning}
        className="z-50"
      >
        <PopoverPrimitive.Popup
          className={cn(
            "bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 w-72 origin-(--transform-origin) rounded-md border p-4 shadow-md outline-none",
            className,
          )}
          {...popup}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent };
