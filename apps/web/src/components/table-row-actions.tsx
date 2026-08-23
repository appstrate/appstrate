// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { MoreHorizontal, Pencil } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";

interface PrimaryAction {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  icon?: LucideIcon;
}

/**
 * The shared end of an actionable table row: one frequent deed stays direct,
 * while secondary and destructive deeds live behind the standard menu.
 * Callers own the menu items because permissions and pending states belong to
 * the resource, not to the table primitive.
 */
export function TableRowActions({
  primary,
  menuLabel,
  children,
}: {
  primary?: PrimaryAction;
  menuLabel?: string;
  children?: ReactNode;
}) {
  const PrimaryIcon = primary?.icon ?? Pencil;

  return (
    <div className="relative z-10 flex items-center justify-end gap-1">
      {primary && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={primary.onSelect}
          disabled={primary.disabled}
          title={primary.label}
          aria-label={primary.label}
        >
          <PrimaryIcon size={14} />
        </Button>
      )}
      {children && menuLabel && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title={menuLabel}
              aria-label={menuLabel}
            >
              <MoreHorizontal size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">{children}</DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
