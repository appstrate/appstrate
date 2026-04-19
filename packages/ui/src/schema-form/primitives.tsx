// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

// Inline Tailwind primitives (shadcn-equivalent look, zero extra deps) shared
// by templates and widgets. Styling relies solely on CSS tokens that all
// Appstrate surfaces expose (`--background`, `--input`, `--primary`, …).

import { cn } from "./cn.ts";

export const INPUT_CLASS =
  "border-input placeholder:text-muted-foreground focus-visible:ring-ring flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:ring-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50";

export const LABEL_CLASS =
  "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70";

const BUTTON_VARIANTS: Record<string, string> = {
  default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
  outline:
    "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
  ghost: "hover:bg-accent hover:text-accent-foreground",
};

const BUTTON_SIZES: Record<string, string> = {
  default: "h-9 px-4 py-2",
  sm: "h-8 rounded-md px-3 text-xs",
  icon: "h-9 w-9",
};

export function Button({
  variant = "default",
  size = "default",
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) {
  return (
    <button
      {...rest}
      className={cn(
        "focus-visible:ring-ring inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-1 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
        BUTTON_VARIANTS[variant] ?? BUTTON_VARIANTS.default,
        BUTTON_SIZES[size] ?? BUTTON_SIZES.default,
        className,
      )}
    />
  );
}
