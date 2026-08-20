// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from "react";
import { NavOrg } from "@/components/nav-org";
import { SidebarBilling } from "@/components/sidebar-billing";
import { ProductSwitcher } from "@/components/product-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarTrigger,
} from "@appstrate/ui/components/sidebar";

export function AppSidebar(props: ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader className="border-sidebar-border h-14 justify-center border-b group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
        <ProductSwitcher />
      </SidebarHeader>
      <SidebarContent className="gap-0">
        <NavOrg />
        <SidebarBilling />
      </SidebarContent>
      {/* The org/workspace switcher now opens the header trail. Two switchers
          for one thing reads as hesitation, so the footer keeps only the
          collapse control. */}
      <SidebarFooter className="border-sidebar-border flex-row items-center justify-end border-t py-1.5">
        <SidebarTrigger />
      </SidebarFooter>
    </Sidebar>
  );
}
