import type { ComponentProps } from "react";
import { OrgSwitcher } from "@/components/org-switcher";
import { NavOrg } from "@/components/nav-org";
import { NavApp } from "@/components/nav-app";
import { SidebarBilling } from "@/components/sidebar-billing";
import { NavUser } from "@/components/nav-user";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from "@/components/ui/sidebar";

export function AppSidebar(props: ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader className="h-16 justify-center border-b border-sidebar-border group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
        <OrgSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <NavOrg />
        <NavApp />
        <SidebarBilling />
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
    </Sidebar>
  );
}
