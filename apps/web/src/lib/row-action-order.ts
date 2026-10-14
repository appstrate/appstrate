// SPDX-License-Identifier: Apache-2.0

import type { LucideIcon } from "lucide-react";

/** One deed of a row's « … » menu (`TableRowActions`). */
export interface RowAction {
  id: string;
  label: string;
  icon: LucideIcon;
  /** A deed that acts here; mutually exclusive with `href`. */
  onSelect?: () => void;
  /** A deed that goes somewhere. */
  href?: string;
  disabled?: boolean;
  /** Destroys or revokes: drawn last, behind a separator, in the destructive tone. */
  destructive?: boolean;
  /** Left out of the menu (the caller's permission or state says no). */
  hidden?: boolean;
  testId?: string;
}

/**
 * The menu's order: the visible deeds in the caller's order, then the
 * destructive ones, which the menu puts behind one separator.
 */
export function orderRowActions(actions: readonly RowAction[]): {
  plain: RowAction[];
  destructive: RowAction[];
} {
  const visible = actions.filter((action) => !action.hidden);
  return {
    plain: visible.filter((action) => !action.destructive),
    destructive: visible.filter((action) => action.destructive),
  };
}
