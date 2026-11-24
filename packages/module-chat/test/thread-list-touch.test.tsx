// SPDX-License-Identifier: Apache-2.0

/**
 * A phone has no hover: the row's rename and delete cannot hide behind it. Each row carries one « … »
 * menu, always there on touch (a 44 px strip), revealed by hover or focus under a fine pointer.
 */

import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SidebarProvider } from "@appstrate/ui/components/sidebar";
import { TooltipProvider } from "@appstrate/ui/components/tooltip";

import {
  ChatConversationList,
  GROUP_CLASS,
  GROUP_LABEL_CLASS,
  GROUP_ROWS_CLASS,
} from "../src/ui/thread-list.tsx";
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

describe("a conversation row's « … »", () => {
  const trigger = () =>
    render(["chat:read", "chat:write"]).match(
      /<button[^>]*aria-label="threads\.actions\.openFor"[^>]*>/,
    )?.[0];

  it("is one menu named for the conversation, a thumb's size on touch", () => {
    const html = render(["chat:read", "chat:write"]);
    // One « … » per row, on every format.
    expect(html.match(/aria-label="threads\.actions\.openFor"/g)).toHaveLength(2);
    expect(trigger()).toContain("w-11");
    expect(trigger()).toContain("h-12");
    expect(trigger()).not.toContain("desktop-pointer:hidden");
  });

  it("is revealed by hover and keyboard focus under a mouse", () => {
    const button = trigger();
    expect(button).toContain("desktop-pointer:opacity-0");
    expect(button).toContain("desktop-pointer:group-hover/menu-item:opacity-100");
    expect(button).toContain("desktop-pointer:group-focus-within/menu-item:opacity-100");
  });
});

describe("the conversation search on a phone", () => {
  const html = render(["chat:read", "chat:write"]);

  it("is a magnifier beside « New conversation », shown below md only", () => {
    const toggle = html.match(/<button[^>]*data-testid="chat-search-toggle"[^>]*>/)?.[0];
    expect(toggle).toBeDefined();
    expect(toggle).toContain("md:hidden");
    expect(toggle).toContain("size-11");
  });

  it("is there for a reader too, who has no « New conversation » beside it", () => {
    const html = render(["chat:read"]);
    const toggle = html.match(/<button[^>]*data-testid="chat-search-toggle"[^>]*>/)?.[0];
    expect(toggle).toContain("md:hidden");
    expect(html).not.toContain("<span>threads.new</span>");
  });

  it("keeps its field folded below md until the magnifier is tapped, always there from md", () => {
    const field = html.match(/<div class="[^"]*max-md:hidden[^"]*"><svg[^>]*lucide-search/)?.[0];
    expect(field).toBeDefined();
  });

  it("puts the field after « New conversation », never above it", () => {
    expect(html.indexOf("threads.new")).toBeLessThan(html.indexOf('type="search"'));
  });
});

describe("a conversation row's line", () => {
  const html = render(["chat:read", "chat:write"]);
  const row = (markup: string) =>
    markup.match(/<button[^>]*data-sidebar="menu-button" data-size="lg"[^>]*>/)?.[0] ?? "";

  it("is one line under a mouse, a thumb's 48 px on touch", () => {
    expect(row(html)).toContain("desktop-pointer:h-8");
    expect(row(html)).toContain("h-12");
  });

  it("closes the title's line with the spaces' tiles, on every format", () => {
    const tiles = html.match(/<span[^>]*data-testid="chat-session-space-tiles"[^>]*>[^<]*/)?.[0];
    expect(tiles).toContain("tiles:spc_a");
    expect(tiles).not.toContain("hidden");
    // No second line: the names are in the tiles' tooltip and the « … » menu.
    expect(html).not.toContain('data-testid="chat-session-spaces"');
    expect(html).not.toMatch(/flex min-w-0 flex-1 items-center gap-2 max-md:flex-col/);
  });

  it("names them on a line of their own for a reader on a phone, whose row has no « … »", () => {
    const reader = render(["chat:read"]);
    const names = reader.match(/<span[^>]*data-testid="chat-session-spaces"[^>]*>/)?.[0];
    expect(names).toContain("md:hidden");
    // The tiles stay on the title's line under a mouse, where hovering names them.
    const tiles = reader.match(/<span[^>]*data-testid="chat-session-space-tiles"[^>]*>/)?.[0];
    expect(tiles).toContain("max-md:hidden");
    expect(reader).toMatch(/flex min-w-0 flex-1 items-center gap-2 max-md:flex-col/);
  });
});

describe("the list's date groups", () => {
  const html = render(["chat:read", "chat:write"]);

  it("sit apart while their rows sit close together", () => {
    expect(GROUP_CLASS).toContain("not-first:mt-4");
    expect(GROUP_ROWS_CLASS).toContain("gap-0.5");
    expect(html).toContain(`<li class="${GROUP_CLASS}">`);
    expect(html).toContain(`<ul class="${GROUP_ROWS_CLASS}">`);
  });

  it("head each group with a semibold, muted label, in small capitals under a mouse", () => {
    expect(GROUP_LABEL_CLASS).toContain("font-semibold");
    expect(GROUP_LABEL_CLASS).toContain("text-sidebar-foreground/60");
    expect(GROUP_LABEL_CLASS).toContain("md:uppercase");
    expect(html).toContain("threads.group.older");
  });

  it("scroll in the design system's scroll area, not the browser's scrollbar", () => {
    expect(html).toContain("data-radix-scroll-area-viewport");
    expect(html).not.toContain("overflow-y-auto pr-2");
  });
});
