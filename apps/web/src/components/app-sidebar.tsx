// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";
import { NavOrg } from "@/components/nav-org";
import { ShellSidebar } from "@/components/shell-frame";
import { SidebarCredits } from "@/components/sidebar-credits";
import { useCanReach } from "@/hooks/use-can-reach";

// The chat's list ships with the chat module's UI, out of the entry chunk; it
// loads INSIDE the frame, so the frame never blanks while it does.
const ChatSidebar = lazy(() =>
  import("../modules/chat/chat-sidebar").then((m) => ({ default: m.ChatSidebar })),
);

/**
 * The shell's sidebar: one frame, filled with the navigation of the product on
 * screen. The frame stays mounted across a product switch; only this content
 * changes.
 */
export function AppSidebar({ product }: { product: "studio" | "chat" }) {
  const canReach = useCanReach();
  if (product === "chat") {
    return (
      <ShellSidebar contentClassName="overflow-hidden">
        {/* A refused chat route says so in the page; the list would only
            fetch what the caller cannot read. */}
        {canReach("/chat") && (
          <Suspense fallback={null}>
            <ChatSidebar />
          </Suspense>
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
