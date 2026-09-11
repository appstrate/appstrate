// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { ChatConversationList, ChatHeadersProvider } from "@appstrate/module-chat/ui";
import { SidebarProvider } from "@appstrate/ui/components/sidebar";
import {
  sessionsQueryKey,
  type SessionSummary,
} from "../../../../../packages/module-chat/src/ui/sessions.ts";
import { render } from "../../test/render.tsx";

function conversation(id: string, title: string, unread: boolean): SessionSummary {
  return { id, title, unread, generating: false, updatedAt: "2026-09-05T10:00:00Z" };
}

describe("chat page session scope", () => {
  it("derives unread markers from the same space cache as its conversation list", () => {
    const qc = new QueryClient();
    qc.setQueryData(sessionsQueryKey("spc_a"), [
      conversation("chat_active", "Active conversation", true),
      conversation("chat_unread", "Unread in A", true),
      conversation("chat_read", "Read in A", false),
    ]);
    qc.setQueryData(sessionsQueryKey("spc_b"), [conversation("chat_other", "Only in B", true)]);

    // This SPA-only component reads visibility from the browser on render.
    // No DOM or effects are needed to observe its real query/provider wiring.
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { visibilityState: "visible" },
    });
    let html: string;
    try {
      // The list is the shell's navigation, not part of `ChatPage`: mounting it
      // directly is what puts the unread markers on screen. The headers
      // provider is what scopes the sessions query to one space, which is the
      // wiring this test is about.
      html = render(
        <SidebarProvider>
          <ChatHeadersProvider value={() => ({ "X-Space-Id": "spc_a" })}>
            <ChatConversationList activeId="chat_active" t={(key) => key} />
          </ChatHeadersProvider>
        </SidebarProvider>,
        { queryClient: qc },
      );
    } finally {
      if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
      else Reflect.deleteProperty(globalThis, "document");
    }

    expect(html).toContain("Unread in A");
    expect(html).toContain("Read in A");
    expect(html).not.toContain("Only in B");
    // The unread dot lives in the list itself, and the test injects an identity
    // `t`, so the rendered label is the KEY. Counting it is what proves the
    // marker is derived from the same scoped query as the rows beside it —
    // `chat_active` is excluded because looking at a thread reads it.
    expect(html.match(/aria-label="list\.unread"/g)).toHaveLength(1);
  });
});
