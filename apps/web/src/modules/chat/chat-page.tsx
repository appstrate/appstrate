// SPDX-License-Identifier: Apache-2.0

// Shell wrapper for the chat module page — the UI itself lives in the
// module package (`@appstrate/module-chat/ui`); this wrapper only injects
// the shell's org/app scoping headers. Lazy-loaded behind `features.chat`.

import { useNavigate, useParams } from "react-router-dom";
import { ChatPage } from "@appstrate/module-chat/ui";
import { buildScopingHeaders } from "../../lib/scoping-headers";

export function ChatModulePage() {
  // Conversation id lives in the URL (`/chat/:conversationId`) so a refresh or
  // deep-link restores the open conversation. `replace` keeps message/title
  // updates out of the back-history.
  const { conversationId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  // The chat's tools (run agents, inspect runs, search…) are served by the
  // `mcp` module, which is a hard peer requirement of `chat` (enforced at
  // boot) — so tools are always available when the chat is reachable.
  // Bound the chat to the viewport height below the app shell's h-16 header so
  // the thread scrolls internally and the composer stays pinned (sticky) at the
  // bottom. Without a definite height here the flex chain grows with the message
  // list and the composer scrolls off-screen.
  return (
    <div className="h-[calc(100dvh-4rem)] min-h-0">
      <ChatPage
        getHeaders={buildScopingHeaders}
        conversationId={conversationId ?? null}
        onConversationChange={(id) => navigate(id ? `/chat/${id}` : "/chat", { replace: true })}
      />
    </div>
  );
}
