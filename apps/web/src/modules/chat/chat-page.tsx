// SPDX-License-Identifier: Apache-2.0

// Shell wrapper for the chat module page — the UI itself lives in the
// module package (`@appstrate/module-chat/ui`); this wrapper only injects
// the shell's org/app scoping headers. Lazy-loaded behind `features.chat`.

import { ChatPage } from "@appstrate/module-chat/ui";
import { getAuthHeaders } from "../../lib/scoping-headers";

export function ChatModulePage() {
  // The chat's tools (run agents, inspect runs, search…) are served by the
  // `mcp` module, which is a hard peer requirement of `chat` (enforced at
  // boot) — so tools are always available when the chat is reachable.
  // Bound the chat to the viewport height below the app shell's h-16 header so
  // the thread scrolls internally and the composer stays pinned (sticky) at the
  // bottom. Without a definite height here the flex chain grows with the message
  // list and the composer scrolls off-screen.
  return (
    <div className="h-[calc(100dvh-4rem)] min-h-0">
      <ChatPage getHeaders={getAuthHeaders} />
    </div>
  );
}
