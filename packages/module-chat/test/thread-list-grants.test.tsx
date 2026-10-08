// SPDX-License-Identifier: Apache-2.0

/**
 * The conversation list, held to the caller's grants: a reader (`chat:read`
 * only) cannot send, and a new conversation IS its first message — so the list
 * offers them none.
 */

import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SidebarProvider } from "@appstrate/ui/components/sidebar";

import { ChatConversationList } from "../src/ui/thread-list.tsx";
import { ChatHeadersProvider } from "../src/ui/runtime-context.ts";
import { sessionsQueryKey, type SessionsCache } from "../src/ui/sessions.ts";

const getHeaders = () => ({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" });

// The list is the shell's navigation, mounted outside `ChatPage`: `t` and `can`
// arrive as props, and it renders into the host's sidebar.
function render(granted: string[]): string {
  const qc = new QueryClient();
  qc.setQueryData<SessionsCache>(sessionsQueryKey("spc_a"), {
    pages: [
      {
        data: [
          { id: "chs_1", title: "Budget", unread: false, generating: false, updatedAt: "" },
          { id: "chs_2", title: null, unread: false, generating: false, updatedAt: "" },
        ],
        hasMore: false,
      },
    ],
    pageParams: [null],
  });
  return renderToString(
    <QueryClientProvider client={qc}>
      <SidebarProvider>
        <ChatHeadersProvider value={getHeaders}>
          <ChatConversationList
            activeId={null}
            t={(key) => key}
            can={(permission) => granted.includes(permission)}
          />
        </ChatHeadersProvider>
      </SidebarProvider>
    </QueryClientProvider>,
  );
}

describe("the conversation list", () => {
  it("offers a new conversation to a caller who can write", () => {
    const html = render(["chat:read", "chat:write"]);
    expect(html).toContain("<span>threads.new</span>");
    expect(html).toContain('aria-label="threads.actions.delete"');
  });

  it("offers a reader no new conversation, and no row action", () => {
    const html = render(["chat:read"]);
    expect(html).toContain("Budget");
    expect(html).not.toContain("<span>threads.new</span>");
    expect(html).not.toContain('aria-label="threads.actions.delete"');
  });
});
