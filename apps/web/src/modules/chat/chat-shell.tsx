// SPDX-License-Identifier: Apache-2.0

/**
 * The chat's own shell.
 *
 * The chat is a PRODUCT beside Studio, not a page inside it, so it does not
 * borrow Studio's navigation — it borrows the shell FRAME both products share
 * (`components/shell-frame.tsx`): the same brand cell with the product switcher
 * (still the way back to Studio), the same 56px header opening on the
 * org/workspace chip, the same meta block at the foot, the same icon rail on
 * collapse. Where Studio lists Activité/Construire, the chat lists
 * conversations. Two products, one app.
 *
 * It replaces the trick this page used to play instead: mounting inside
 * `MainLayout` and collapsing the Studio sidebar on mount
 * (`setOpenTransient(false)`). That left the rail sitting there, spending 48px
 * and a column of unreadable icons on a navigation the chat never uses, and it
 * made the chat's own conversation list the SECOND sidebar on screen.
 */

import type { ReactNode } from "react";
import {
  ChatConversationList,
  ChatHeadersProvider,
  SelectConversationProvider,
  type ChatTranslate,
  type GetHeaders,
  type SelectConversation,
} from "@appstrate/module-chat/ui";
import { SidebarInset, SidebarProvider } from "@appstrate/ui/components/sidebar";
import { ShellHeader, ShellSidebar } from "@/components/shell-frame";
import { useApplicationResolver } from "@/hooks/use-current-application";
import { useChatSidebarStore } from "@/stores/sidebar-store";
import { ChatTitleCrumb } from "./chat-title-crumb";

export function ChatShell({
  getHeaders,
  conversationId,
  onConversationChange,
  headerActions,
  t,
  children,
}: {
  getHeaders: GetHeaders;
  conversationId: string | null;
  onConversationChange: SelectConversation;
  /** Host actions for the header's right end (the context panel's tabs). */
  headerActions?: ReactNode;
  t: ChatTranslate;
  children: ReactNode;
}) {
  // Every request the chat makes is scoped by the current workspace, and it is
  // this hook that resolves one. `MainLayout` calls it for the rest of the app;
  // the chat no longer passes through it.
  useApplicationResolver();
  const { open, setOpen } = useChatSidebarStore();

  // The chat's two contexts, raised over the WHOLE shell rather than published
  // again by each piece: the conversation list, the breadcrumb title and the
  // thread all read them from here, and share one sessions query between them.
  return (
    <ChatHeadersProvider value={getHeaders}>
      <SelectConversationProvider value={onConversationChange}>
        <SidebarProvider open={open} onOpenChange={setOpen}>
          {/* `overflow-hidden` so the scroll happens on the conversation list
              itself, not on the whole column — the new-conversation row above
              it must stay put while the history scrolls under it. */}
          <ShellSidebar contentClassName="overflow-hidden">
            <ChatConversationList activeId={conversationId} t={t} />
          </ShellSidebar>
          {/* No page scroll here, unlike Studio's inset: the chat owns its
              height, the thread scrolls inside itself and the composer stays
              pinned. */}
          <SidebarInset className="bg-canvas h-svh min-h-0 overflow-hidden">
            <ChatTitleCrumb conversationId={conversationId} t={t} />
            <ShellHeader actions={headerActions} fullBleed />
            <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
          </SidebarInset>
        </SidebarProvider>
      </SelectConversationProvider>
    </ChatHeadersProvider>
  );
}
