// SPDX-License-Identifier: Apache-2.0

import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../cn.ts";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        // Icon buttons are a thumb's size on touch (44 px) and their own under a mouse
        // (`desktop-pointer:`, a wide screen with a fine pointer): 40 px, or 32 px for `icon-sm`.
        icon: "size-11 desktop-pointer:size-10",
        "icon-sm": "size-11 desktop-pointer:size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends useRender.ComponentProps<"button">, VariantProps<typeof buttonVariants> {}

/**
 * A `<button>`, or the element `render` gives it (a link) with the button's look and nothing else:
 * no role or keyboard handling is added, so a link stays a link.
 */
function Button({ className, variant, size, render, ref, ...props }: ButtonProps) {
  return useRender({
    defaultTagName: "button",
    render,
    ref,
    props: { ...props, className: cn(buttonVariants({ variant, size, className })) },
  });
}

export { Button, buttonVariants };
