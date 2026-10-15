// SPDX-License-Identifier: Apache-2.0

import type { To } from "react-router-dom";
import type { LucideIcon } from "lucide-react";

/**
 * One deed of a menu, declared once whichever menu draws it. `onSelect` acts in
 * place, `to` goes to an app route, `href` opens an external page in a new tab.
 */
export interface MenuAction {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect?: () => void;
  to?: To;
  href?: string;
  disabled?: boolean;
  /** Destroys or revokes: drawn last, behind a separator, in the destructive tone. */
  destructive?: boolean;
  hidden?: boolean;
  testId?: string;
}

/** The visible deeds, the destructive ones apart: a menu draws them last, behind a separator. */
export function splitMenuActions(actions: readonly MenuAction[]): {
  plain: MenuAction[];
  destructive: MenuAction[];
} {
  const visible = actions.filter((action) => !action.hidden);
  return {
    plain: visible.filter((action) => !action.destructive),
    destructive: visible.filter((action) => action.destructive),
  };
}
