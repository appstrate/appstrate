// SPDX-License-Identifier: Apache-2.0

/**
 * A conversation's « … » (its spaces, Renommer, Supprimer): on a row under a mouse, revealed by hover
 * or focus; on touch a row has none, and the open conversation's header carries it on every format.
 */

import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SidebarProvider } from "@appstrate/ui/components/sidebar";
import { TooltipProvider } from "@appstrate/ui/components/tooltip";

import {
  ChatConversationList,
  ChatConversationMenu,
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

  it("is one menu named for the conversation, a mouse's alone: a row on touch has none", () => {
    const html = render(["chat:read", "chat:write"]);
    expect(html.match(/aria-label="threads\.actions\.openFor"/g)).toHaveLength(2);
    expect(trigger()).toMatch(/(?:^|\s)hidden(?:\s|")/);
    expect(trigger()).toContain("desktop-pointer:flex");
  });

  it("draws its hover square on itself alone, the row lit behind it, under a mouse", () => {
    const html = render(["chat:read", "chat:write"]);
    expect(trigger()).toContain("size-6");
    expect(trigger()).toContain("desktop-pointer:hover:bg-sidebar-foreground/10");
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

  it("keeps the age out of the way while the row's menu is open, the mouse gone to the menu", () => {
    const html = render(["chat:read", "chat:write"]);
    const age = html.match(/<span class="[^"]*desktop-pointer:inline[^"]*">age/)?.[0];
    expect(age).toContain("desktop-pointer:group-has-[[aria-expanded=true]]/menu-item:opacity-0");
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
});

describe("the list's date groups", () => {
  const html = render(["chat:read", "chat:write"]);

  it("sit apart from « New conversation » and from each other while their rows sit close together", () => {
    expect(GROUP_CLASS).toContain("mt-4");
    expect(GROUP_ROWS_CLASS).not.toContain("gap-");
    expect(html).toContain(`class="${GROUP_CLASS}"`);
    expect(html).toContain(`class="${GROUP_ROWS_CLASS}"`);
  });

  it("head each group with a semibold label, darker than its rows, written as said, lit on hover", () => {
    expect(GROUP_LABEL_CLASS).toContain("font-semibold");
    expect(GROUP_LABEL_CLASS.split(" ")).toContain("text-sidebar-foreground");
    expect(GROUP_LABEL_CLASS).not.toContain("uppercase");
    expect(GROUP_LABEL_CLASS).toContain("desktop-pointer:hover:bg-sidebar-accent");
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

  it("fade the edge that hides rows, on the viewport that scrolls", () => {
    expect(html).toContain("[&amp;_[data-radix-scroll-area-viewport]]:scroll-fade-y");
  });
});

describe("the open conversation's « … » in the header", () => {
  function header(activeId: string | null, granted: string[] = ["chat:read", "chat:write"]) {
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
          ],
          hasMore: false,
        },
      ],
      pageParams: [undefined],
    });
    return renderToString(
      <QueryClientProvider client={qc}>
        <ChatTransportProvider value={transport}>
          <ChatConversationMenu
            activeId={activeId}
            t={(key) => key}
            can={(permission) => granted.includes(permission)}
            renderSpaces={(ids) => ids.join(", ")}
          />
        </ChatTransportProvider>
      </QueryClientProvider>,
    );
  }

  it("is the row's menu, named for the open conversation, on every format", () => {
    const button = header("chs_1").match(
      /<button[^>]*data-testid="chat-conversation-menu"[^>]*>/,
    )?.[0];
    expect(button).toContain('aria-label="threads.actions.openFor"');
    expect(button).toContain("size-11");
    expect(button).toContain("desktop-pointer:size-8");
    expect(button).not.toMatch(/(?:^|\s)hidden(?:\s|")/);
  });

  it("is there for a reader too, who reads the spaces in it", () => {
    expect(header("chs_1", ["chat:read"])).toContain('data-testid="chat-conversation-menu"');
  });

  it("draws nothing on a new conversation", () => {
    expect(header(null)).toBe("");
  });
});
