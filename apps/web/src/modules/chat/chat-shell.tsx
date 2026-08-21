// SPDX-License-Identifier: Apache-2.0

/**
 * The chat's own shell.
 *
 * The chat is a PRODUCT beside Studio, not a page inside it, so it does not
 * borrow Studio's navigation: it borrows the shell's GRAMMAR. Same brand cell
 * with the product switcher (still the way back to Studio), same 56px header
 * opening on the org/workspace chip, same meta block at the foot, same icon
 * rail on collapse — and, in the place where Studio lists Activité/Construire,
 * the list of conversations. Two products, one app.
 *
 * It replaces the trick this page used to play instead: mounting inside
 * `MainLayout` and collapsing the Studio sidebar on mount
 * (`setOpenTransient(false)`). That left the rail sitting there, spending 48px
 * and a column of unreadable icons on a navigation the chat never uses, and it
 * made the chat's own conversation list the SECOND sidebar on screen.
 *
 * The sidebar keeps its own open/closed state rather than sharing Studio's
 * (`useSidebarStore`): they are different surfaces with different contents, and
 * folding one is no statement about the other. Studio's persisted preference is
 * therefore left strictly alone — which is what the transient setter was
 * working around.
 */

import type { ReactNode } from "react";
import { useState } from "react";
import { ChatConversationList, ChatConversationTitle } from "@appstrate/module-chat/ui";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@appstrate/ui/components/sidebar";
import { NavUser } from "@/components/nav-user";
import { NotificationBell } from "@/components/notification-bell";
import { OrgSwitcher } from "@/components/org-switcher";
import { ProductSwitcher } from "@/components/product-switcher";
import { SidebarMeta } from "@/components/sidebar-meta";
import { useApplicationResolver } from "@/hooks/use-current-application";

export function ChatShell({
  getHeaders,
  conversationId,
  onConversationChange,
  headerActions,
  children,
}: {
  getHeaders: () => Record<string, string>;
  conversationId: string | null;
  onConversationChange: (id: string | null) => void;
  /** Host actions for the header's right end (the context panel's tabs). */
  headerActions?: ReactNode;
  children: ReactNode;
}) {
  // Every request the chat makes is scoped by the current workspace, and it is
  // this hook that resolves one. `MainLayout` calls it for the rest of the app;
  // the chat no longer passes through it.
  useApplicationResolver();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  return (
    <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
      <Sidebar collapsible="icon">
        <SidebarHeader className="border-sidebar-border h-header justify-center border-b">
          <ProductSwitcher />
        </SidebarHeader>
        {/* `overflow-hidden` so the scroll happens on the conversation list
            itself, not on the whole column — the new-conversation row above it
            must stay put while the history scrolls under it. */}
        <SidebarContent className="gap-0 overflow-hidden">
          <ChatConversationList
            getHeaders={getHeaders}
            activeId={conversationId}
            onConversationChange={onConversationChange}
          />
        </SidebarContent>
        <SidebarFooter className="gap-0 p-0">
          <SidebarMeta />
          <div className="border-sidebar-border flex items-center justify-end border-t px-2 py-1.5">
            <SidebarTrigger />
          </div>
        </SidebarFooter>
      </Sidebar>
      {/* No page scroll here, unlike Studio's inset: the chat owns its height,
          the thread scrolls inside itself and the composer stays pinned. */}
      <SidebarInset className="bg-canvas h-svh min-h-0 overflow-hidden">
        {/* Full width, no `max-w-page`: the surface underneath is full-bleed,
            and a header centred on 1300px over an edge-to-edge chat would put
            the profile 300px short of the right edge it belongs to. */}
        <header className="bg-canvas h-header px-gutter flex shrink-0 items-center gap-2 border-b">
          <SidebarTrigger className="md:hidden" />
          <nav
            aria-label="breadcrumb"
            className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-sm"
          >
            <OrgSwitcher />
            {conversationId ? (
              <>
                <span className="text-border shrink-0 select-none" aria-hidden>
                  /
                </span>
                <ChatConversationTitle getHeaders={getHeaders} activeId={conversationId} />
              </>
            ) : null}
          </nav>
          <div className="flex shrink-0 items-center gap-1">
            {headerActions}
            <NotificationBell />
            <NavUser />
          </div>
        </header>
        <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
