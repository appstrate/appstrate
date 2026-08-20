// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from "react";
import { NavOrg } from "@/components/nav-org";
import { SidebarBilling } from "@/components/sidebar-billing";
import { SidebarMeta } from "@/components/sidebar-meta";
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
      </SidebarContent>
      {/* Foot of the sidebar, in decreasing weight: the usage gauge, the meta
          rows, then the collapse control. The org/workspace switcher used to
          live here and now opens the header trail — two switchers for one thing
          reads as hesitation. */}
      <SidebarFooter className="gap-0 p-0">
        <SidebarBilling />
        <SidebarMeta />
        <div className="border-sidebar-border flex items-center justify-end border-t px-2 py-1.5">
          <SidebarTrigger />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
