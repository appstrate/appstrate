// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { DropdownMenuItem, DropdownMenuLinkItem } from "@appstrate/ui/components/dropdown-menu";
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
  const variant = action.destructive ? "destructive" : "default";
  const link =
    action.to !== undefined ? (
      <Link to={action.to} onClick={replacingNavigation(action.onSelect)} />
    ) : action.href !== undefined ? (
      <a href={action.href} target="_blank" rel="noopener noreferrer" />
    ) : undefined;
  // A link item has no disabled state: a disabled deed is a plain item that does nothing.
  if (link && !action.disabled) {
    return (
      <DropdownMenuLinkItem variant={variant} render={link} {...marks}>
        {body}
      </DropdownMenuLinkItem>
    );
  }
  return (
    <DropdownMenuItem
      variant={variant}
      disabled={action.disabled}
      onClick={link ? undefined : action.onSelect}
      {...marks}
    >
      {body}
    </DropdownMenuItem>
  );
}
