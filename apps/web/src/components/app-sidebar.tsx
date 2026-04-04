// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from "react";
import { OrgSwitcher } from "@/components/org-switcher";
import { AppSwitcher } from "@/components/app-switcher";
import { NavOrg } from "@/components/nav-org";
import { SidebarBilling } from "@/components/sidebar-billing";
import { NavUser } from "@/components/nav-user";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from "@/components/ui/sidebar";

export function AppSidebar(props: ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader className="border-sidebar-border justify-center border-b group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
        <OrgSwitcher />
        <AppSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <NavOrg />
        <SidebarBilling />
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
    </Sidebar>
  );
}
