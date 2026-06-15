// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal local button for the module UI — same look as the shell's shadcn
 * Button for the variants the thread uses, without importing apps/web
 * internals (a module package only depends on inherited theme tokens).
 */

import * as React from "react";

type Variant = "default" | "secondary" | "ghost" | "outline";
type Size = "default" | "sm" | "icon";

const VARIANTS: Record<Variant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  ghost: "hover:bg-accent hover:text-accent-foreground",
  outline: "border bg-background hover:bg-accent hover:text-accent-foreground",
};

const SIZES: Record<Size, string> = {
  default: "h-9 px-4 py-2",
  sm: "h-8 rounded-md px-3 text-xs",
  icon: "size-9",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "default", size = "default", className, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      className={`focus-visible:ring-ring inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors outline-none focus-visible:ring-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 ${VARIANTS[variant]} ${SIZES[size]} ${className ?? ""}`}
      {...props}
    />
  ),
);
Button.displayName = "Button";
