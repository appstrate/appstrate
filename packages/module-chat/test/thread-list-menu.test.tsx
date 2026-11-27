// SPDX-License-Identifier: Apache-2.0

/**
 * The open conversation's « … » in the host's header: the same menu a row has (its spaces, then
 * Renommer and Supprimer), a header icon button's size (32 px under a mouse, 44 px on touch),
 * named for assistive tech. A reader gets it too (the spaces alone); a conversation not stored yet
 * gets none.
 */

import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SidebarProvider } from "@appstrate/ui/components/sidebar";
import { TooltipProvider } from "@appstrate/ui/components/tooltip";
import { ChatConversationList, ChatConversationMenu } from "../src/ui/thread-list.tsx";
import { ChatTransportProvider } from "../src/ui/runtime-context.ts";
import { sessionsQueryKey, type SessionsCache, type SessionSummary } from "../src/ui/sessions.ts";
import { transportOf } from "./fake-request.ts";

const transport = transportOf(() => ({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" }));
const budget: SessionSummary = {
  id: "chs_1",
  title: "Budget",
  unread: false,
  generating: false,
  updatedAt: "",
  spaceId: "spc_a",
  restricted: false,
  space_ids: ["spc_a", "spc_b"],
};

function render(node: React.ReactElement): string {
  const qc = new QueryClient();
  qc.setQueryData<SessionsCache>(sessionsQueryKey("spc_a"), {
    pages: [{ data: [budget], hasMore: false }],
    pageParams: [undefined],
  });
  return renderToString(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <SidebarProvider>
          <ChatTransportProvider value={transport}>{node}</ChatTransportProvider>
        </SidebarProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const writer = (permission: string) => permission === "chat:read" || permission === "chat:write";
const reader = (permission: string) => permission === "chat:read";
const renderSpaces = (ids: readonly string[]) => ids.join(", ");

const header = (activeId: string | null, can = writer) =>
  render(
    <ChatConversationMenu
      activeId={activeId}
      t={(key) => key}
      can={can}
      renderSpaces={renderSpaces}
    />,
  );

/** The menu trigger a render holds, by its accessible name. */
const trigger = (html: string, label: string) =>
  html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];

describe("the open conversation's « … » in the header", () => {
  it("is one menu trigger, named for the conversation's actions", () => {
    const button = trigger(header("chs_1"), "threads\\.actions\\.conversation");
    expect(button).toBeDefined();
    expect(button).toContain('aria-haspopup="menu"');
    expect(button).toContain('data-testid="chat-conversation-menu"');
  });

  it("is a header icon button: 44 px on touch, 32 px under a mouse", () => {
    const button = trigger(header("chs_1"), "threads\\.actions\\.conversation");
    expect(button).toContain("size-11");
    expect(button).toContain("desktop-pointer:size-8");
  });

  it("is the menu a row opens: the same trigger kind, beside the row's own", () => {
    const list = render(
      <ChatConversationList
        activeId="chs_1"
        t={(key) => key}
        can={writer}
        renderSpaces={renderSpaces}
      />,
    );
    const row = trigger(list, "threads\\.actions\\.openFor");
    const head = trigger(header("chs_1"), "threads\\.actions\\.conversation");
    for (const button of [row, head]) {
      expect(button).toContain('aria-haspopup="menu"');
      expect(button).toContain('data-state="closed"');
    }
  });

  it("is there for a reader too: it names the conversation's spaces", () => {
    const button = trigger(header("chs_1", reader), "threads\\.actions\\.conversation");
    expect(button).toContain('aria-haspopup="menu"');
    expect(button).toContain('data-testid="chat-conversation-menu"');
  });

  it("is not there on a new conversation, nor for one the caller cannot read", () => {
    expect(header(null)).not.toContain("<button");
    expect(header("chs_unknown")).not.toContain("<button");
  });
});
