// SPDX-License-Identifier: Apache-2.0

/**
 * A phone has no hover: the row's rename and delete cannot hide behind it. Below `md` each row
 * carries a "…" menu (a 44 px strip); the hover buttons are for `md` and up.
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
              renderSpaces={(ids) => ids.join(", ")}
            />
          </ChatTransportProvider>
        </SidebarProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("a conversation row on a phone", () => {
  it("has an actions menu named for the conversation, shown below md only", () => {
    const html = render(["chat:read", "chat:write"]);
    const trigger = html.match(/<button[^>]*aria-label="threads\.actions\.openFor"[^>]*>/)?.[0];
    expect(trigger).toBeDefined();
    expect(trigger).toContain("md:hidden");
    expect(trigger).toContain("w-11");
    expect(trigger).toContain("h-12");
  });

  it("hides the hover buttons below md", () => {
    const html = render(["chat:read", "chat:write"]);
    const hover = html.match(
      /<div class="[^"]*group-hover\/menu-item:pointer-events-auto[^"]*">/,
    )?.[0];
    expect(hover).toBeDefined();
    expect(hover).toContain("max-md:hidden");
  });

  it("gives a reader no menu", () => {
    const html = render(["chat:read"]);
    expect(html).not.toContain("threads.actions.openFor");
  });
});
