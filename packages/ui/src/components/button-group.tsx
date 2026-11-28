// SPDX-License-Identifier: Apache-2.0

import { cn } from "../cn.ts";

/**
 * shadcn's `button-group` (horizontal only). Deviation: our `Button` carries no `data-slot`,
 * so the joined edges are squared with `:not(:first-child)` / `:not(:last-child)` instead of
 * slot selectors.
 */
function ButtonGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="group"
      data-slot="button-group"
      className={cn(
        "flex w-fit items-stretch [&>*]:focus-visible:relative [&>*]:focus-visible:z-10 [&>*:not(:first-child)]:rounded-l-none [&>*:not(:first-child)]:border-l-0 [&>*:not(:last-child)]:rounded-r-none",
        className,
      )}
      {...props}
    />
  );
}

export { ButtonGroup };
