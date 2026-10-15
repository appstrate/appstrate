// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import type { MenuAction } from "../lib/menu-action";

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
