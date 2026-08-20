// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from "react";
import { Link } from "react-router-dom";
import { NavOrg } from "@/components/nav-org";
import { SidebarBilling } from "@/components/sidebar-billing";
import { AppstrateMark } from "@/components/appstrate-mark";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarTrigger,
} from "@appstrate/ui/components/sidebar";

/**
 * Brand cell: the mark plus the product name, never the "appstrate" wordmark.
 *
 * The redesign drops the wordmark here on purpose — the header already says
 * which PRODUCT you are in ("Studio"), and the product switcher next to the
 * profile is what moves you between them. Repeating the company name in the
 * one place that should name the product wastes the slot.
 */
function SidebarLogo() {
  return (
    <Link
      to="/"
      className="flex w-full items-center gap-2 pl-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:pl-0"
    >
      <AppstrateMark className="h-7 w-auto shrink-0" />
      <span className="text-[1.02rem] font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
        Studio
      </span>
    </Link>
  );
}

export function AppSidebar(props: ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader className="border-sidebar-border h-14 justify-center border-b group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
        <SidebarLogo />
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
