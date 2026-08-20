// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from "react";
import { NavOrg } from "@/components/nav-org";
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
      <SidebarHeader className="border-sidebar-border h-header justify-center border-b">
        <ProductSwitcher />
      </SidebarHeader>
      <SidebarContent className="gap-0">
        <NavOrg />
      </SidebarContent>
      {/* Foot of the sidebar: the meta rows, then the collapse control. No
          credits gauge — a permanent progress bar spends attention every second
          on a number that is consulted every few weeks. It belongs behind the
          Usage row, not in front of the navigation. The org/workspace switcher
          used to live here too and now opens the header trail. */}
      <SidebarFooter className="gap-0 p-0">
        <SidebarMeta />
        <div className="border-sidebar-border flex items-center justify-end border-t px-2 py-1.5">
          <SidebarTrigger />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
