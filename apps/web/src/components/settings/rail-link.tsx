// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { cn } from "@appstrate/ui/cn";

export interface RailLinkItem {
  to: string;
  icon: LucideIcon;
  labelKey: string;
}

function railItemClass(active: boolean, mobile: boolean): string {
  return cn(
    "grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center justify-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
    mobile && "min-h-11",
    active
      ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
  );
}

/** Shared settings-style rail row for settings and embedded configuration. */
export function RailLink({
  item,
  label,
  active,
  state,
  mobile = false,
  onNavigate,
}: {
  item: RailLinkItem;
  label: string;
  active: boolean;
  state?: unknown;
  mobile?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to={item.to}
      state={state}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={railItemClass(active, mobile)}
    >
      <item.icon className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
    </Link>
  );
}

/** Button counterpart used by local rails that do not navigate to another route. */
export function RailButton({
  icon: Icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={railItemClass(active, false)}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
      {count !== undefined && (
        <span className="bg-muted text-muted-foreground inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-medium tabular-nums">
          {count}
        </span>
      )}
    </button>
  );
}
