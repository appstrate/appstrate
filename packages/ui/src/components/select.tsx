// SPDX-License-Identifier: Apache-2.0

/**
 * A select. `<SelectValue>` draws the chosen item's label only when the root is given `items`
 * (value → label): Base UI renders the raw value otherwise.
 */

import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "../cn.ts";
import { splitAnchoring, type WithClassName } from "./primitive-props.ts";

/**
 * A single choice that is never cleared: `onValueChange` gets a value, not Base UI's `null` (sent
 * only when no item carries that value, which no call site has).
 */
function Select<Value>({
  onValueChange,
  ...props
}: Omit<SelectPrimitive.Root.Props<Value, false>, "onValueChange" | "multiple"> & {
  onValueChange?: (value: Value, details: SelectPrimitive.Root.ChangeEventDetails) => void;
}) {
  return (
    <SelectPrimitive.Root
      {...props}
      onValueChange={(value, details) => {
        if (value !== null) onValueChange?.(value, details);
      }}
    />
  );
}

const SelectGroup = SelectPrimitive.Group;

function SelectValue({ className, ...props }: WithClassName<SelectPrimitive.Value.Props>) {
  return <SelectPrimitive.Value className={cn("line-clamp-1", className)} {...props} />;
}

function SelectTrigger({
  className,
  children,
  ...props
}: WithClassName<SelectPrimitive.Trigger.Props>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "border-input bg-background ring-offset-background data-placeholder:text-muted-foreground focus:ring-ring flex h-10 w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm focus:ring-2 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon render={<ChevronDown className="h-4 w-4 shrink-0 opacity-50" />} />
    </SelectPrimitive.Trigger>
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: WithClassName<SelectPrimitive.ScrollUpArrow.Props>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      className={cn(
        "bg-popover top-0 z-10 flex w-full cursor-default items-center justify-center py-1",
        className,
      )}
      {...props}
    >
      <ChevronUp className="h-4 w-4" />
    </SelectPrimitive.ScrollUpArrow>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: WithClassName<SelectPrimitive.ScrollDownArrow.Props>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      className={cn(
        "bg-popover bottom-0 z-10 flex w-full cursor-default items-center justify-center py-1",
        className,
      )}
      {...props}
    >
      <ChevronDown className="h-4 w-4" />
    </SelectPrimitive.ScrollDownArrow>
  );
}

type SelectContentProps = WithClassName<SelectPrimitive.Popup.Props> &
  Omit<SelectPrimitive.Positioner.Props, "className" | "render" | "style" | "children">;

/** Below its trigger and at least as wide, not over it (Base UI lines the chosen item up with the trigger by default). */
function SelectContent({
  className,
  children,
  sideOffset = 4,
  alignItemWithTrigger = false,
  ...props
}: SelectContentProps) {
  const [positioning, popup] = splitAnchoring(props);
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        className="z-50"
        sideOffset={sideOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        {...positioning}
      >
        <SelectPrimitive.Popup
          className={cn(
            "bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative max-h-(--available-height) min-w-(--anchor-width) origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-md border shadow-md outline-none",
            className,
          )}
          {...popup}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List className="p-1">{children}</SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }: WithClassName<SelectPrimitive.GroupLabel.Props>) {
  return (
    <SelectPrimitive.GroupLabel
      className={cn("py-1.5 pr-2 pl-8 text-sm font-semibold", className)}
      {...props}
    />
  );
}

function SelectItem({ className, children, ...props }: WithClassName<SelectPrimitive.Item.Props>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground relative flex w-full cursor-default items-center rounded-sm py-1.5 pr-2 pl-8 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="h-4 w-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({ className, ...props }: WithClassName<SelectPrimitive.Separator.Props>) {
  return (
    <SelectPrimitive.Separator className={cn("bg-muted -mx-1 my-1 h-px", className)} {...props} />
  );
}

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
};
