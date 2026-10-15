// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from "react";
import { cn } from "@appstrate/ui/cn";
import { TOOLBAR_ACTION, TOOLBAR_PRIMARY } from "../lib/toolbar-button";
import { PendingButton } from "./app-ui/pending-button";

/**
 * A deed in a detail page's header (`DetailBar` `actions`): Run, Re-run, Cancel,
 * Activate. One look for every page: outline on a surface at the toolbar's height,
 * or, with `primary`, the single filled button of the bar. Colour an icon through
 * its own `className` (`text-primary`, `text-destructive`).
 */
export function HeaderActionButton({
  primary = false,
  className,
  ...props
}: Omit<ComponentProps<typeof PendingButton>, "variant" | "size"> & {
  /** The bar's one filled button; at most one per page. */
  primary?: boolean;
}) {
  return (
    <PendingButton
      variant={primary ? "default" : "outline"}
      size="sm"
      className={cn(primary ? TOOLBAR_PRIMARY : TOOLBAR_ACTION, className)}
      {...props}
    />
  );
}
