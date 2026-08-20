// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { SidebarMenuItem, SidebarMenuButton } from "@appstrate/ui/components/sidebar";

export function SidebarNavLink({
  to,
  icon: Icon,
  label,
  isActive,
  children,
  state,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  isActive: boolean;
  children?: ReactNode; // badges, indicators
  /** Navigation state — used to keep a routed modal open across its own rail. */
  state?: unknown;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive} tooltip={label}>
        <Link to={to} state={state}>
          <Icon />
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
      {children}
    </SidebarMenuItem>
  );
}
