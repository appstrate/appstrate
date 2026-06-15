// SPDX-License-Identifier: Apache-2.0

// Shell wrapper for the chat module page — the UI itself lives in the
// module package (`@appstrate/module-chat/ui`); this wrapper only injects
// the shell's org/app scoping headers. Lazy-loaded behind `features.chat`.

import { ChatPage } from "@appstrate/module-chat/ui";
import { getAuthHeaders } from "../../lib/scoping-headers";
import { useAppConfig } from "../../hooks/use-app-config";

export function ChatModulePage() {
  // The chat's tools (run agents, inspect runs, search…) are served by the
  // `mcp` module. Surface its availability so the chat shows a "no tools"
  // banner when it's off (the backend degrades to plain conversation).
  const { features } = useAppConfig();
  // Bound the chat to the viewport height below the app shell's h-16 header so
  // the thread scrolls internally and the composer stays pinned (sticky) at the
  // bottom. Without a definite height here the flex chain grows with the message
  // list and the composer scrolls off-screen.
  return (
    <div className="h-[calc(100dvh-4rem)] min-h-0">
      <ChatPage getHeaders={getAuthHeaders} toolsAvailable={Boolean(features.mcp)} />
    </div>
  );
}
