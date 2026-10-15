// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@appstrate/ui/components/sidebar";
import { NavOrg } from "@/components/nav-org";
import { ShellSidebar } from "@/components/shell-frame";
import { SidebarCredits } from "@/components/sidebar-credits";
import { useCanReach, useReachReady } from "@/hooks/use-can-reach";

// The chat's list ships with the chat module's UI, out of the entry chunk; it
// loads INSIDE the frame, so the frame never blanks while it does.
const ChatSidebar = lazy(() =>
  import("../modules/chat/chat-sidebar").then((m) => ({ default: m.ChatSidebar })),
);

/**
 * The conversation list's shape, drawn while its permissions and chunk load:
 * the "new conversation" row (the chat's primary action, so it is real, not
 * grey) above a group of row skeletons — what `ChatConversationList` draws.
 */
function ChatSidebarSkeleton() {
  const { t } = useTranslation("chat");
  return (
    <>
      <SidebarGroup className="pb-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton disabled tooltip={t("threads.new")}>
              <Plus />
              <span>{t("threads.new")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
      <SidebarGroup className="min-h-0 flex-1 group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel>{t("threads.title")}</SidebarGroupLabel>
        <SidebarMenu>
          {Array.from({ length: 5 }, (_, i) => (
            <SidebarMenuItem key={i}>
              <SidebarMenuSkeleton />
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroup>
    </>
  );
}

/**
 * The shell's sidebar: one frame, filled with the navigation of the product on
 * screen. The frame stays mounted across a product switch; only this content
 * changes.
 */
export function AppSidebar({ product }: { product: "studio" | "chat" }) {
  const canReach = useCanReach();
  const ready = useReachReady();
  if (product === "chat") {
    return (
      <ShellSidebar contentClassName="overflow-hidden">
        {/* A refused chat route says so in the page; the list would only
            fetch what the caller cannot read. */}
        {!ready ? (
          <ChatSidebarSkeleton />
        ) : (
          canReach("/chat") && (
            <Suspense fallback={<ChatSidebarSkeleton />}>
              <ChatSidebar />
            </Suspense>
          )
        )}
      </ShellSidebar>
    );
  }
  return (
    <ShellSidebar>
      <NavOrg />
      <SidebarCredits />
    </ShellSidebar>
  );
}
