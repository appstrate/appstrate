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
function render(granted: string[], activeId: string | null = null): string {
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
              activeId={activeId}
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

  it("is one menu named for the conversation, always there on touch, the row's height", () => {
    const html = render(["chat:read", "chat:write"]);
    // One « … » per row, on every format.
    expect(html.match(/aria-label="threads\.actions\.openFor"/g)).toHaveLength(2);
    expect(trigger()).toContain("w-10");
    expect(trigger()).toContain("h-9");
    expect(trigger()).not.toContain("desktop-pointer:hidden");
  });

  it("draws its hover square on itself alone, the row lit behind it, under a mouse", () => {
    const html = render(["chat:read", "chat:write"]);
    expect(trigger()).toContain("desktop-pointer:size-6");
    expect(trigger()).toContain("desktop-pointer:hover:bg-sidebar-foreground/10");
    // No backdrop on the age's slot: it was a wide pill beside the « … ».
    expect(html).not.toContain(
      "group-hover/menu-item:bg-sidebar-accent desktop-pointer:group-focus-within",
    );
    const row = html.match(/<button[^>]*data-sidebar="menu-button" data-size="lg"[^>]*>/)?.[0];
    expect(row).toContain("desktop-pointer:group-hover/menu-item:bg-sidebar-accent");
  });

  it("is revealed by hover and keyboard focus under a mouse", () => {
    const button = trigger();
    expect(button).toContain("desktop-pointer:opacity-0");
    expect(button).toContain("desktop-pointer:group-hover/menu-item:opacity-100");
    expect(button).toContain("desktop-pointer:group-focus-within/menu-item:opacity-100");
    expect(button).not.toContain("desktop-pointer:opacity-100");
  });

  it("stays in view under a mouse on the open conversation, in place of its age", () => {
    const html = render(["chat:read", "chat:write"], "chs_1");
    const triggers = html.match(/<button[^>]*aria-label="threads\.actions\.openFor"[^>]*>/g) ?? [];
    expect(triggers[0]).toContain("desktop-pointer:opacity-100");
    expect(triggers[1]).not.toContain("desktop-pointer:opacity-100");
    const ages = html.match(/<span class="[^"]*desktop-pointer:inline[^"]*">age/g) ?? [];
    expect(ages[0]).toMatch(/(?:^|\s)desktop-pointer:opacity-0(?:\s|")/);
    expect(ages[1]).not.toMatch(/(?:^|\s)desktop-pointer:opacity-0(?:\s|")/);
  });
});

describe("the sidebar's head, the phone's on every format", () => {
  const html = render(["chat:read", "chat:write"]);

  it("draws « New conversation » with its « + » in a round tile, folded to the « + » in the icon rail", () => {
    const tile = html.match(/<span class="[^"]*rounded-full[^"]*"><svg[^>]*lucide-plus/)?.[0];
    expect(tile).toContain("bg-sidebar-accent");
    expect(tile).toContain("size-7");
    expect(tile).toContain("desktop-pointer:size-6");
    expect(tile).toContain("group-data-[collapsible=icon]:contents");
    expect(tile).not.toMatch(/(?:^|\s)(?:max-)?md:/);
  });

  it("puts the search's magnifier beside that row, not over it, on every format", () => {
    const toggle = html.match(/<button[^>]*data-testid="chat-search-toggle"[^>]*>/)?.[0];
    expect(toggle).toBeDefined();
    expect(toggle).not.toContain("md:hidden");
    expect(toggle).toContain("size-10");
    expect(toggle).toContain("desktop-pointer:size-8");
    // A sibling in the row's flex line: the row's hover stops before it.
    expect(toggle).not.toContain("absolute");
    expect(html).toMatch(
      /<li[^>]*data-sidebar="menu-item"[^>]*class="[^"]*flex items-center gap-1/,
    );
    expect(toggle).toContain("group-data-[collapsible=icon]:hidden");
    expect(html.indexOf("threads.new")).toBeLessThan(html.indexOf("chat-search-toggle"));
  });

  it("is there for a reader too, who has no « New conversation » beside it", () => {
    const html = render(["chat:read"]);
    const toggle = html.match(/<button[^>]*data-testid="chat-search-toggle"[^>]*>/)?.[0];
    expect(toggle).toBeDefined();
    expect(toggle).not.toContain("md:hidden");
    expect(html).not.toContain("<span>threads.new</span>");
  });

  it("keeps the field folded into the magnifier until it is tapped", () => {
    expect(html).not.toContain('type="search"');
  });
});

describe("a conversation row's line", () => {
  const html = render(["chat:read", "chat:write"]);
  const row = (markup: string) =>
    markup.match(/<button[^>]*data-sidebar="menu-button" data-size="lg"[^>]*>/)?.[0] ?? "";

  it("is one dense line on every format: 32 px under a mouse, 36 on touch, in regular weight", () => {
    expect(row(html)).toContain("desktop-pointer:h-8");
    expect(row(html)).toMatch(/(?:^|\s)h-9(?:\s|")/);
    expect(row(html)).toContain("font-normal");
    expect(row(html)).toContain("text-sidebar-foreground/75");
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

  it("sit apart from « New conversation » and from each other while their rows sit close together", () => {
    expect(GROUP_CLASS).toContain("mt-4");
    expect(GROUP_ROWS_CLASS).not.toContain("gap-");
    expect(html).toContain(`class="${GROUP_CLASS}"`);
    expect(html).toContain(`class="${GROUP_ROWS_CLASS}"`);
  });

  it("head each group with a semibold label, darker than its rows, in small capitals under a mouse", () => {
    expect(GROUP_LABEL_CLASS).toContain("font-semibold");
    expect(GROUP_LABEL_CLASS.split(" ")).toContain("text-sidebar-foreground");
    expect(GROUP_LABEL_CLASS).toContain("md:uppercase");
    expect(html).toContain("threads.group.older");
  });

  it("fold and unfold from their heading, open until folded", () => {
    const heading = html.match(/<button[^>]*data-sidebar="group-label"[^>]*>/)?.[0];
    expect(heading).toContain('aria-expanded="true"');
    expect(heading).toContain('data-state="open"');
    expect(html).toMatch(/lucide-chevron-down[^"]*"[^>]*/);
  });

  it("scroll in the design system's scroll area, not the browser's scrollbar", () => {
    expect(html).toContain("data-radix-scroll-area-viewport");
    expect(html).not.toContain("overflow-y-auto pr-2");
  });
});
