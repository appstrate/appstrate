// SPDX-License-Identifier: Apache-2.0

/**
 * The conversation list names the spaces each conversation touched (through the host's rendering),
 * under every filter: a conversation can have touched other spaces than the selected one.
 */

import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SidebarProvider } from "@appstrate/ui/components/sidebar";
import { TooltipProvider } from "@appstrate/ui/components/tooltip";
import { ChatConversationList } from "../src/ui/thread-list.tsx";
import { ChatTransportProvider } from "../src/ui/runtime-context.ts";
import { sessionsQueryKey, type SessionsCache, type SessionSummary } from "../src/ui/sessions.ts";
import { transportOf } from "./fake-request.ts";

const base = { unread: false, generating: false, updatedAt: "", spaceId: null, restricted: false };
const sessions: SessionSummary[] = [
  { ...base, id: "chs_1", title: "In a space", space_ids: ["spc_a"] },
  { ...base, id: "chs_2", title: "Across", space_ids: ["spc_a", "spc_b"] },
  { ...base, id: "chs_3", title: "Fresh", space_ids: [] },
];

/** The list under `filter` (`null`: « Tous les espaces »), seeded with `rows`, for a writer or a reader. */
function render(filter: string | null, rows = sessions, canWrite = true): string {
  const transport = transportOf(() => ({ "X-Org-Id": "org_1" }), filter);
  const qc = new QueryClient();
  qc.setQueryData<SessionsCache>(sessionsQueryKey(filter), {
    pages: [{ data: rows, hasMore: false }],
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
              can={(permission) => canWrite || permission !== "chat:write"}
              renderSpaces={(ids) => <i data-spaces={ids.join(",")}>spaces</i>}
              formatAge={() => "age"}
            />
          </ChatTransportProvider>
        </SidebarProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("the conversation list's spaces", () => {
  for (const [mode, filter] of [
    ["in « Tous les espaces »", null],
    ["under a selected space", "spc_a"],
  ] as const) {
    it(`shows the spaces every conversation touched ${mode}`, () => {
      const html = render(filter);
      expect(html).toContain('data-spaces="spc_a"');
      expect(html).toContain('data-spaces="spc_a,spc_b"');
    });

    it(`says « Tous les espaces » on a reader's line for a conversation that touched none ${mode}`, () => {
      expect(render(filter, sessions, false)).toContain("common:overview.title");
    });
  }

  it("closes the title's line with their tiles on every row that touched one", () => {
    // Two rows touched a space, none skipped for being the filter's own space; the fresh one
    // has no tiles, and a writer's row no second line.
    const html = render("spc_a");
    expect(html.match(/data-testid="chat-session-space-tiles"/g)).toHaveLength(2);
    expect(html).not.toContain('data-testid="chat-session-spaces"');
  });

  it("names them on a line of their own for every reader's row on a phone", () => {
    const html = render("spc_a", sessions, false);
    expect(html.match(/data-testid="chat-session-spaces"/g)).toHaveLength(3);
  });
});
