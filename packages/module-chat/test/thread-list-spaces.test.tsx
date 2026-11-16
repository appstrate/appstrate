// SPDX-License-Identifier: Apache-2.0

/**
 * The conversation list names each session's space in an organization scope (through the host's
 * rendering), and only there: a space's list is all one space.
 */

import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SidebarProvider } from "@appstrate/ui/components/sidebar";
import { TooltipProvider } from "@appstrate/ui/components/tooltip";
import { ChatConversationList } from "../src/ui/thread-list.tsx";
import { ChatTransportProvider, type ChatScope } from "../src/ui/runtime-context.ts";
import { sessionsQueryKey, type SessionsCache, type SessionSummary } from "../src/ui/sessions.ts";
import { chatScopeKey } from "../src/ui/scope.ts";
import { transportOf } from "./fake-request.ts";

const base = { unread: false, generating: false, updatedAt: "" };
const sessions: SessionSummary[] = [
  { ...base, id: "chs_1", title: "In a space", spaceId: "spc_a", space_ids: [] },
  { ...base, id: "chs_2", title: "Across", spaceId: null, space_ids: ["spc_a", "spc_b"] },
  { ...base, id: "chs_3", title: "Fresh", spaceId: null, space_ids: [] },
];

function render(
  scope: ChatScope,
  withSeam = true,
  canIn?: (spaceId: string, permission: string) => boolean,
): string {
  const transport = transportOf(() => ({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" }), scope);
  const qc = new QueryClient();
  qc.setQueryData<SessionsCache>(sessionsQueryKey(chatScopeKey(transport)), {
    pages: [{ data: sessions, hasMore: false }],
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
              can={() => true}
              canIn={canIn}
              renderSpaces={
                withSeam ? (ids) => <i data-spaces={ids.join(",")}>spaces</i> : undefined
              }
            />
          </ChatTransportProvider>
        </SidebarProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("the conversation list's space line", () => {
  const org = { kind: "organization", orgId: "org_1" } as const;

  it("names a space session's space and an organization session's touched spaces", () => {
    const html = render(org);
    expect(html).toContain('data-spaces="spc_a"');
    expect(html).toContain('data-spaces="spc_a,spc_b"');
  });

  it("says « Vue d'ensemble » for an organization session that touched no space", () => {
    expect(render(org)).toContain("threads.overview");
  });

  it("draws no space line in a space", () => {
    const html = render({ kind: "space" });
    expect(html).not.toContain("data-spaces");
    expect(html).not.toContain("threads.overview");
  });

  it("draws none without the host's rendering", () => {
    expect(render(org, false)).not.toContain("threads.overview");
  });

  it("judges a space session's row actions in its own space, an organization session's by the scope", () => {
    const html = render(org, true, (spaceId) => spaceId === "spc_b");
    // `spc_a`'s session may not be written by the caller there: only the two organization rows delete.
    expect(html.match(/aria-label="common:btn\.delete"/g)).toHaveLength(2);
    expect(html.match(/aria-label="threads\.settings\.openFor"/g)).toHaveLength(2);
  });
});
