// SPDX-License-Identifier: Apache-2.0

import { Children, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import { orderRowActions, type RowAction } from "../lib/row-action-order";
import { Spinner } from "./spinner";

export type { RowAction };

function RowActionItem({ action }: { action: RowAction }) {
  const Icon = action.icon;
  const body = (
    <>
      <Icon />
      {action.label}
    </>
  );
  return (
    <DropdownMenuItem
      variant={action.destructive ? "destructive" : "default"}
      disabled={action.disabled}
      onSelect={action.onSelect}
      asChild={action.href !== undefined}
      {...(action.testId ? { "data-testid": action.testId } : {})}
    >
      {action.href !== undefined ? <Link to={action.href}>{body}</Link> : body}
    </DropdownMenuItem>
  );
}

/**
 * The shared end of an actionable table row, and its ONLY way to act: one « … »
 * menu holding every action of the row, never a pencil or any other icon beside
 * it. Order, always: edit or rename first, the resource's own deeds next,
 * delete last behind a separator. What a click on the row opens (the edit, or
 * the detail through `rowHref`) is the table's, not this component's.
 * Callers own the menu items because permissions and pending states belong to
 * the resource, not to the table primitive: they pass `actions` (ordered and
 * separated here) and, for what `actions` cannot say (sub-menus, a hint, a rich
 * item), their own `children`, drawn after the plain deeds and before the
 * destructive ones. A row with nothing to offer renders no menu at all (no
 * `menuLabel`, or no visible action and no rendered child).
 */
export function TableRowActions({
  menuLabel,
  isPending = false,
  renaming = false,
  actions,
  children,
}: {
  menuLabel?: string;
  actions?: RowAction[];
  isPending?: boolean;
  /**
   * True while the row's name is in inline edit, started from this menu's
   * « Rename ». The menu holds focus until it has finished closing, so a field
   * that focuses itself at once loses it again: when the menu is gone, focus goes
   * to the row's text field (selected) instead of back to the « … ».
   */
  renaming?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation("common");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { plain, destructive } = orderRowActions(actions ?? []);
  const hasChildren = Children.toArray(children).length > 0;
  const hasItems = plain.length > 0 || destructive.length > 0 || hasChildren;
  return (
    <div className="relative z-10 flex items-center justify-end gap-1">
      {isPending && <Spinner label={t("loading")} />}
      {hasItems && menuLabel && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              ref={triggerRef}
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title={menuLabel}
              aria-label={menuLabel}
              disabled={isPending}
            >
              <MoreHorizontal size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={(event) => {
              if (!renaming) return;
              event.preventDefault();
              const field = triggerRef.current?.closest("tr")?.querySelector("input");
              field?.focus();
              field?.select();
            }}
          >
            {plain.map((action) => (
              <RowActionItem key={action.id} action={action} />
            ))}
            {children}
            {(plain.length > 0 || hasChildren) && destructive.length > 0 && (
              <DropdownMenuSeparator />
            )}
            {destructive.map((action) => (
              <RowActionItem key={action.id} action={action} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
