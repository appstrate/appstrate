// SPDX-License-Identifier: Apache-2.0

// Toggle styling only. The standalone `Toggle` component was removed: nothing
// imported it — `toggle-group.tsx` consumes just these variants.

import { cva } from "class-variance-authority";

const toggleVariants = cva(
  "ring-offset-background hover:bg-muted hover:text-muted-foreground focus-visible:ring-ring inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border-input bg-transparent hover:bg-accent hover:text-accent-foreground border",
      },
      size: {
        default: "h-10 min-w-10 px-3",
        sm: "h-9 min-w-9 px-2.5",
        lg: "h-11 min-w-11 px-5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export { toggleVariants };
