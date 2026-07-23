// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from "react";
import { Link } from "react-router-dom";
import { OrgSwitcher } from "@/components/org-switcher";
import { NavOrg } from "@/components/nav-org";
import { SidebarBilling } from "@/components/sidebar-billing";
import { UpdateBadge } from "@/components/update-badge";
import { useTheme } from "@/stores/theme-store";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarTrigger,
} from "@appstrate/ui/components/sidebar";

/**
 * Sidebar header branding + collapse control.
 *
 * - Expanded: wordmark logo + collapse toggle (toggle pinned right).
 * - Collapsed: square app icon only.
 * - Collapsed + hovered: the icon is swapped for the collapse toggle, which
 *   stays clickable to re-open the sidebar.
 */
function SidebarLogo() {
  const { resolvedTheme } = useTheme();

  return (
    <div className="group/logo flex w-full items-center gap-2 pl-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:pl-0">
      <Link to="/" className="flex items-center group-data-[collapsible=icon]:hidden">
        <img
          src={resolvedTheme === "dark" ? "/logo-dark.svg" : "/logo-light.svg"}
          alt="Appstrate"
          className="h-7 w-auto"
        />
      </Link>
      {/* Collapsed-only app icon — hidden as soon as the header is hovered */}
      <img
        src={resolvedTheme === "dark" ? "/icon-dark.svg" : "/icon-light.svg"}
        alt="Appstrate"
        className="hidden size-7 shrink-0 group-data-[collapsible=icon]:block group-data-[collapsible=icon]:group-hover/logo:hidden"
      />
      {/* Toggle: always shown when expanded; collapsed only on hover */}
      <SidebarTrigger className="ml-auto shrink-0 group-data-[collapsible=icon]:ml-0 group-data-[collapsible=icon]:hidden group-data-[collapsible=icon]:group-hover/logo:flex" />
    </div>
  );
}

export function AppSidebar(props: ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader className="border-sidebar-border h-16 justify-center border-b group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
        <SidebarLogo />
      </SidebarHeader>
      <SidebarContent className="gap-0">
        <NavOrg />
        <SidebarBilling />
      </SidebarContent>
      <SidebarFooter>
        <UpdateBadge />
        <OrgSwitcher />
      </SidebarFooter>
    </Sidebar>
  );
}
