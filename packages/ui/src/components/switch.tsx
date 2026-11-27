// SPDX-License-Identifier: Apache-2.0

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "../cn.ts";

/**
 * A native `<button>`: a sibling `<label htmlFor>` names it and the `disabled:` styles apply, as
 * the call sites expect (the primitive's default `<span>` only works inside a wrapping label).
 */
function Switch({
  className,
  ...props
}: Omit<SwitchPrimitive.Root.Props, "className" | "render" | "nativeButton"> & {
  className?: string;
}) {
  return (
    <SwitchPrimitive.Root
      nativeButton
      render={<button type="button" />}
      className={cn(
        "peer focus-visible:ring-ring focus-visible:ring-offset-background data-checked:bg-primary data-unchecked:bg-input inline-flex h-6 w-11 shrink-0 cursor-pointer items-center justify-start rounded-full border-2 border-transparent transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="bg-background pointer-events-none block h-5 w-5 rounded-full shadow-lg ring-0 transition-transform data-checked:translate-x-5 data-unchecked:translate-x-0" />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
