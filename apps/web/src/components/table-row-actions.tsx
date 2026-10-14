// SPDX-License-Identifier: Apache-2.0

import { useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MoreHorizontal, type LucideIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import { Spinner } from "./spinner";

/** One deed of a row's « … » menu. */
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
 * The menu's items in the order the rule above sets: the caller's order, then
 * the destructive deeds behind one separator.
 */
function RowActionItems({ actions }: { actions: RowAction[] }) {
  const plain = actions.filter((action) => !action.destructive);
  const destructive = actions.filter((action) => action.destructive);
  const item = (action: RowAction) => {
    const Icon = action.icon;
    const body = (
      <>
        <Icon />
        {action.label}
      </>
    );
    return (
      <DropdownMenuItem
        key={action.id}
        variant={action.destructive ? "destructive" : "default"}
        disabled={action.disabled}
        onSelect={action.onSelect}
        asChild={action.href !== undefined}
        {...(action.testId ? { "data-testid": action.testId } : {})}
      >
        {action.href !== undefined ? <Link to={action.href}>{body}</Link> : body}
      </DropdownMenuItem>
    );
  };
  return (
    <>
      {plain.map(item)}
      {plain.length > 0 && destructive.length > 0 && <DropdownMenuSeparator />}
      {destructive.map(item)}
    </>
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
 * separated here) or, for a menu `actions` cannot say (sub-menus, a rich item),
 * their own `children`. A row with nothing to offer renders no menu at all (no
 * `menuLabel`, or no visible action and no children).
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
  const visible = actions?.filter((action) => !action.hidden) ?? [];
  const items =
    visible.length > 0 ? (
      <>
        <RowActionItems actions={visible} />
        {children}
      </>
    ) : (
      children
    );
  return (
    <div className="relative z-10 flex items-center justify-end gap-1">
      {isPending && <Spinner label={t("loading")} />}
      {items && menuLabel && (
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
            {items}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
