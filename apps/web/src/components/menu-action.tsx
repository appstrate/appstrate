// SPDX-License-Identifier: Apache-2.0

import { Link, type To } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";

/**
 * One deed of a menu, declared once whichever menu draws it: a row's « … »
 * (`TableRowActions`), a page's Actions menu (`PageActionsMenu`), or the button
 * of an empty collection (`EmptyStateAction`). `onSelect` acts in place, `to`
 * goes to a route of the app, `href` opens an external page in a new tab.
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
  /** Left out of the menu (the caller's permission or state says no). */
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

/** A deed as a menu entry. A page's deed is marked `data-page-action` with its id. */
export function MenuActionItem({
  action,
  pageAction = false,
}: {
  action: MenuAction;
  pageAction?: boolean;
}) {
  const Icon = action.icon;
  const body = (
    <>
      <Icon />
      {action.label}
    </>
  );
  const marks = {
    ...(pageAction ? { "data-page-action": action.id } : {}),
    ...(action.testId ? { "data-testid": action.testId } : {}),
  };
  const linked = action.to !== undefined || action.href !== undefined;
  return (
    <DropdownMenuItem
      variant={action.destructive ? "destructive" : "default"}
      disabled={action.disabled}
      onSelect={action.onSelect}
      asChild={linked}
      {...(linked ? {} : marks)}
    >
      {action.to !== undefined ? (
        <Link to={action.to} {...marks}>
          {body}
        </Link>
      ) : action.href !== undefined ? (
        <a href={action.href} target="_blank" rel="noopener noreferrer" {...marks}>
          {body}
        </a>
      ) : (
        body
      )}
    </DropdownMenuItem>
  );
}
