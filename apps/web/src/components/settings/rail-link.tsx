// SPDX-License-Identifier: Apache-2.0

import { Lock } from "lucide-react";
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { cn } from "@appstrate/ui/cn";

interface RailLinkItem {
  to: string;
  icon: LucideIcon;
}

/**
 * A rail row. Its label wraps rather than truncates: a navigation entry cut to
 * « Serveurs MCP loc… » no longer names where it leads.
 */
function railItemClass(active: boolean): string {
  return cn(
    "grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center justify-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
    active
      ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
  );
}

/** Shared settings-style rail row for settings and embedded configuration. */
function RailCount({ count }: { count: number }) {
  return (
    <span className="bg-muted text-muted-foreground inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-medium tabular-nums">
      {count}
    </span>
  );
}

export function RailLink({
  item,
  label,
  active,
  locked = false,
  count,
}: {
  item: RailLinkItem;
  label: string;
  active: boolean;
  /** The entry stays, its content says what the role does not allow: a lock marks it. */
  locked?: boolean;
  count?: number;
}) {
  return (
    <Link to={item.to} aria-current={active ? "page" : undefined} className={railItemClass(active)}>
      <item.icon className="size-4 shrink-0" />
      <span className="leading-snug break-words">{label}</span>
      {locked && <Lock className="text-muted-foreground ml-auto size-3.5 shrink-0" aria-hidden />}
      {count !== undefined && <RailCount count={count} />}
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
      className={railItemClass(active)}
    >
      <Icon className="size-4 shrink-0" />
      <span className="leading-snug break-words">{label}</span>
      {count !== undefined && <RailCount count={count} />}
    </button>
  );
}
