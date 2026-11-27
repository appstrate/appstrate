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
            unread: true,
            generating: false,
            updatedAt: "",
            space_ids: ["spc_a"],
          },
          {
            id: "chs_2",
            title: null,
            unread: false,
            generating: true,
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
    expect(html.match(/aria-label="threads\.actions\.openFor"/g)).toHaveLength(
      html.match(/data-testid="chat-session-space-tiles"/g)!.length,
    );
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

  it("takes the place of the whole right side (tiles and status) under a mouse", () => {
    const trailing = render(["chat:read", "chat:write"]).match(
      /<span[^>]*data-testid="chat-session-trailing"[^>]*>/,
    )?.[0];
    expect(trailing).toContain("desktop-pointer:min-w-6");
    expect(trailing).toContain("desktop-pointer:group-hover/menu-item:opacity-0");
    expect(trailing).toContain("desktop-pointer:group-focus-within/menu-item:opacity-0");
    expect(trailing).toContain("desktop-pointer:group-has-[[data-state=open]]/menu-item:opacity-0");
  });
});

describe("a reader's right side", () => {
  it("stays on hover: a reader has no « … » to take its place", () => {
    const html = render(["chat:read"]);
    const trailing = html.match(/<span[^>]*data-testid="chat-session-trailing"[^>]*>/)?.[0];
    expect(trailing).toBeDefined();
    expect(trailing).not.toContain("opacity-0");
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

describe("a conversation row, on every format", () => {
  for (const [who, granted] of [
    ["a writer", ["chat:read", "chat:write"]],
    ["a reader", ["chat:read"]],
  ] as const) {
    const html = render([...granted]);

    it(`is one line for ${who}: the title, then the space tiles`, () => {
      const tiles = html.match(/<span[^>]*data-testid="chat-session-space-tiles"[^>]*>[^<]*/)?.[0];
      expect(tiles).toContain("tiles:spc_a");
      expect(html).not.toContain('data-testid="chat-session-spaces"');
      expect(html).toMatch(/flex min-w-0 flex-1 items-center gap-2/);
      expect(html).toContain("desktop-pointer:h-8");
    });

    it(`ends the right side with the status, never a date, for ${who}`, () => {
      expect(html.match(/data-testid="chat-session-status"/g)).toHaveLength(2);
      // The tiles come first, the status last: one block, aligned on the right.
      const trailing = html.match(
        /data-testid="chat-session-trailing"[\s\S]*?<\/span><\/span>/,
      )?.[0];
      expect(trailing?.indexOf("chat-session-space-tiles")).toBeLessThan(
        trailing!.indexOf("chat-session-status"),
      );
      expect(html).toContain('aria-label="threads.unread"');
      expect(html).toContain('aria-label="threads.generating"');
    });
  }
});

describe("the list while it loads", () => {
  /** The list with nothing cached yet: its first page is still on its way. */
  function loading(granted: string[]): string {
    return renderToString(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <SidebarProvider>
            <ChatTransportProvider value={transport}>
              <ChatConversationList
                activeId={null}
                t={(key) => key}
                can={(permission) => granted.includes(permission)}
                renderSpaces={(ids) => ids.join(", ")}
              />
            </ChatTransportProvider>
          </SidebarProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  }
  /** The right padding of a row's box, which sets where its space tiles end. */
  const padding = (box: string | undefined) =>
    box
      ?.match(/class="([^"]*)"/)?.[1]
      ?.split(/\s+/)
      .filter((token) => /^(desktop-pointer:)?pr-/.test(token))
      .sort()
      .join(" ");

  for (const [who, granted] of [
    ["a writer", ["chat:read", "chat:write"]],
    ["a reader", ["chat:read"]],
  ] as const) {
    it(`stands where the loaded list will for ${who}: search, a date label, rows`, () => {
      const html = loading([...granted]);
      expect(html).toContain('type="search"');
      expect(html).not.toContain("threads.title");
      expect(html).toMatch(/data-sidebar="group-label"[^>]*class="[^"]*mt-1 h-10 justify-start/);
      const skeleton = html.match(/<div data-sidebar="menu-skeleton"[^>]*>/)?.[0];
      const row = render([...granted]).match(
        /<button[^>]*data-sidebar="menu-button"[^>]*data-size="lg"[^>]*>/,
      )?.[0];
      expect(skeleton).toContain("desktop-pointer:h-8");
      if (granted.includes("chat:write")) expect(padding(row)).toBe("desktop-pointer:pr-2 pr-11");
      expect(padding(skeleton)).toBe(padding(row));
    });
  }
});
