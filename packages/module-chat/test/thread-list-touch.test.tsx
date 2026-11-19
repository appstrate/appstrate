// SPDX-License-Identifier: Apache-2.0

/**
 * A phone has no hover: the row's rename and delete cannot hide behind it. On touchscreens each row
 * carries a "…" menu (a 44 px strip); the hover buttons are for wide screens with a fine pointer.
 */

import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SidebarProvider } from "@appstrate/ui/components/sidebar";
import { TooltipProvider } from "@appstrate/ui/components/tooltip";

import { ChatConversationList } from "../src/ui/thread-list.tsx";
import { ChatTransportProvider } from "../src/ui/runtime-context.ts";
import { sessionsQueryKey, type SessionsCache } from "../src/ui/sessions.ts";
import { transportOf } from "./fake-request.ts";

const transport = transportOf(() => ({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" }));

// The list is the shell's navigation, mounted outside `ChatPage`: `t` and `can`
// arrive as props, and it renders into the host's sidebar.
function render(granted: string[]): string {
  const qc = new QueryClient();
  qc.setQueryData<SessionsCache>(sessionsQueryKey("spc_a"), {
    pages: [
      {
        data: [
          {
            id: "chs_1",
            title: "Budget",
            unread: false,
            generating: false,
            updatedAt: "",
            space_ids: ["spc_a"],
          },
          {
            id: "chs_2",
            title: null,
            unread: false,
            generating: false,
            updatedAt: "",
            space_ids: ["spc_a"],
          },
        ],
        hasMore: false,
      },
    ],
    pageParams: [undefined],
  });
  return renderToString(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <SidebarProvider>
          <ChatTransportProvider value={transport}>
            <ChatConversationList
              activeId={null}
              t={(key) => key}
              can={(permission) => granted.includes(permission)}
              renderSpaces={(ids, options) =>
                options?.tilesOnly ? `tiles:${ids.join(",")}` : ids.join(", ")
              }
              formatAge={() => "age"}
            />
          </ChatTransportProvider>
        </SidebarProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("a conversation row on a phone", () => {
  it("has an actions menu named for the conversation, shown on touchscreens", () => {
    const html = render(["chat:read", "chat:write"]);
    const trigger = html.match(/<button[^>]*aria-label="threads\.actions\.openFor"[^>]*>/)?.[0];
    expect(trigger).toBeDefined();
    expect(trigger).toContain("desktop-pointer:hidden");
    expect(trigger).toContain("w-11");
    expect(trigger).toContain("h-12");
  });

  it("shows the desktop buttons on both hover and keyboard focus", () => {
    const html = render(["chat:read", "chat:write"]);
    const hover = html.match(
      /<div class="[^"]*group-hover\/menu-item:pointer-events-auto[^"]*">/,
    )?.[0];
    expect(hover).toBeDefined();
    expect(hover).toContain("desktop-pointer:flex");
    expect(hover).toContain("group-focus-within/menu-item:opacity-100");
  });

  it("gives a reader no menu", () => {
    const html = render(["chat:read"]);
    expect(html).not.toContain("threads.actions.openFor");
  });
});

describe("the conversation search on a phone", () => {
  const html = render(["chat:read", "chat:write"]);

  it("is a magnifier beside « New conversation », shown below md only", () => {
    const toggle = html.match(/<button[^>]*data-testid="chat-search-toggle"[^>]*>/)?.[0];
    expect(toggle).toBeDefined();
    expect(toggle).toContain("md:hidden");
    expect(toggle).toContain("size-11");
    expect(toggle).toContain('aria-expanded="false"');
  });

  it("keeps its field folded below md until the magnifier is tapped, always there from md", () => {
    const field = html.match(/<div class="[^"]*max-md:hidden[^"]*"><svg[^>]*lucide-search/)?.[0];
    expect(field).toBeDefined();
  });

  it("puts the field after « New conversation », never above it", () => {
    expect(html.indexOf("threads.new")).toBeLessThan(html.indexOf('type="search"'));
  });
});

describe("a conversation's spaces on a phone", () => {
  const html = render(["chat:read", "chat:write"]);

  it("closes the title's line with their tiles, and keeps the names line for md and up", () => {
    const tiles = html.match(/<span[^>]*data-testid="chat-session-space-tiles"[^>]*>[^<]*/)?.[0];
    expect(tiles).toContain("max-md:flex");
    expect(tiles).toContain("tiles:spc_a");
    const names = html.match(/<span[^>]*data-testid="chat-session-spaces"[^>]*>/)?.[0];
    expect(names).toContain("max-md:hidden");
  });

  it("puts the title and the tiles on one line below md", () => {
    expect(html).toMatch(/flex min-w-0 flex-1 flex-col[^"]*max-md:flex-row/);
  });
});
