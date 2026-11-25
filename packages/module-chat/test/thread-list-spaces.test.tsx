// SPDX-License-Identifier: Apache-2.0

/**
 * The conversation list shows the spaces each conversation touched (through the host's rendering),
 * under every filter: a conversation can have touched other spaces than the selected one. A
 * writer's row closes its title's line with their tiles (the names are in its « … » menu); a
 * reader's, which has no « … », names them on a line of their own.
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
function render(filter: string | null, { write = true, rows = sessions } = {}): string {
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
              can={(permission) => write || permission !== "chat:write"}
              renderSpaces={(ids, options) => (
                <i
                  data-spaces={ids.join(",")}
                  data-tiles-only={options?.tilesOnly ? "" : undefined}
                >
                  spaces
                </i>
              )}
              formatAge={() => "age"}
            />
          </ChatTransportProvider>
        </SidebarProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const MODES = [
  ["in « Tous les espaces »", null],
  ["under a selected space", "spc_a"],
] as const;

describe("a writer's conversation row", () => {
  for (const [mode, filter] of MODES) {
    it(`closes the title's line with the tiles of every space it touched ${mode}`, () => {
      const html = render(filter);
      expect(html).toContain('data-spaces="spc_a" data-tiles-only=""');
      expect(html).toContain('data-spaces="spc_a,spc_b" data-tiles-only=""');
    });
  }

  it("draws no names line, and no tiles for a conversation that touched no space", () => {
    const html = render("spc_a");
    expect(html).not.toContain('data-testid="chat-session-spaces"');
    // Two rows touched a space, none skipped for being the filter's own; the third has none.
    expect(html.match(/data-testid="chat-session-space-tiles"/g)).toHaveLength(2);
    expect(html).not.toContain("common:overview.title");
  });
});

describe("a reader's conversation row", () => {
  for (const [mode, filter] of MODES) {
    it(`names the spaces every conversation touched ${mode}`, () => {
      const html = render(filter, { write: false });
      expect(html).toContain('data-spaces="spc_a"');
      expect(html).toContain('data-spaces="spc_a,spc_b"');
      expect(html).not.toContain("data-tiles-only");
    });

    it(`says « Tous les espaces » for a conversation that touched no space ${mode}`, () => {
      expect(render(filter, { write: false })).toContain("common:overview.title");
    });
  }

  it("draws a line on every row", () => {
    // Three rows: three space lines, none of them skipped for being the filter's own space.
    expect(
      render("spc_a", { write: false }).match(/data-testid="chat-session-spaces"/g),
    ).toHaveLength(3);
  });
});
