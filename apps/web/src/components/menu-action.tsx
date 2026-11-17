// SPDX-License-Identifier: Apache-2.0

import { cn } from "@appstrate/ui/cn";
import { Link } from "react-router-dom";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { replacingNavigation, type MenuAction } from "../lib/menu-action";
import { SpaceChoiceSubmenu } from "./space-choice-menu";

/** A deed as a menu entry (a sub-menu of spaces when it asks for one, `inSpaces`). A page's deed is marked `data-page-action` with its id. */
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
  // The reader chooses the space first: the entry opens the menu of them.
  if (action.inSpaces && !action.disabled) {
    return <SpaceChoiceSubmenu choice={action.inSpaces} trigger={body} marks={marks} />;
  }
  const linked = action.to !== undefined || action.href !== undefined;
  return (
    <DropdownMenuItem
      className={cn(action.destructive && "text-destructive focus:text-destructive")}
      disabled={action.disabled}
      onSelect={action.to !== undefined ? undefined : action.onSelect}
      asChild={linked}
      {...(linked ? {} : marks)}
    >
      {action.to !== undefined ? (
        <Link to={action.to} onClick={replacingNavigation(action.onSelect)} {...marks}>
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
