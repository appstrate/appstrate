// SPDX-License-Identifier: Apache-2.0

/**
 * A conversation's origin space and limit: what its first message carries, when « Limiter à cet
 * espace » is on offer, the PATCH that changes it (optimistic, rolled back), the chip, and where a
 * limited conversation's tool calls are read.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@appstrate/ui/components/tooltip";

import { changeLimit, creationFields } from "../src/ui/conversation-limit.ts";
import {
  callSpace,
  ConversationScopeProvider,
  limitAvailability,
  pinnedSpaceOf,
  type ConversationScope,
} from "../src/ui/conversation-scope.ts";
import { ComposerTools } from "../src/ui/composer-tools.tsx";
import { ChatHostProvider, type ChatHost } from "../src/ui/runtime-context.ts";
import {
  sessionQueryKey,
  sessionsQueryKey,
  type SessionHistory,
  type SessionsCache,
  type SessionSummary,
} from "../src/ui/sessions.ts";
import { requestAnswering, transportOf, transportOver } from "./fake-request.ts";

describe("what the first message carries", () => {
  it("is the origin space, and the limit only when it is on", () => {
    expect(creationFields({ spaceId: "spc_a", restricted: false })).toEqual({ spaceId: "spc_a" });
    expect(creationFields({ spaceId: "spc_a", restricted: true })).toEqual({
      spaceId: "spc_a",
      restricted: true,
    });
  });

  it("is nothing from « Vue d'ensemble », whatever was toggled", () => {
    expect(creationFields({ spaceId: null, restricted: false })).toEqual({});
    expect(creationFields({ spaceId: null, restricted: true })).toEqual({});
  });
});

describe("when the limit is on offer", () => {
  const acting = ["spc_a"];

  it("is when the conversation has an origin space the chat acts in", () => {
    expect(limitAvailability({ originSpaceId: "spc_a", restricted: false }, acting)).toEqual({
      available: true,
    });
  });

  it("is not in « Vue d'ensemble » or for a conversation without an origin", () => {
    expect(limitAvailability({ originSpaceId: null, restricted: false }, acting)).toEqual({
      available: false,
      reason: "no-space",
    });
  });

  it("is not when the origin space is outside the acting set", () => {
    expect(limitAvailability({ originSpaceId: "spc_x", restricted: false }, acting)).toEqual({
      available: false,
      reason: "outside",
    });
  });

  it("always lets a limited conversation be released", () => {
    expect(limitAvailability({ originSpaceId: "spc_x", restricted: true }, acting)).toEqual({
      available: true,
    });
  });
});

describe("changing the limit of an existing conversation", () => {
  const row: SessionSummary = {
    id: "chs_1",
    title: "T",
    generating: false,
    unread: false,
    updatedAt: "",
    spaceId: "spc_a",
    restricted: false,
    space_ids: ["spc_a"],
  };
  const history: SessionHistory = {
    messages: [],
    skills: { skillMode: "auto", pinnedSkills: [] },
    spaceId: "spc_a",
    restricted: false,
  };

  function seeded() {
    const qc = new QueryClient();
    qc.setQueryData<SessionHistory | null>(sessionQueryKey("chs_1"), history);
    qc.setQueryData<SessionsCache>(sessionsQueryKey("spc_a"), {
      pages: [{ data: [row], hasMore: false }],
      pageParams: [undefined],
    });
    return qc;
  }
  const restrictedOf = (qc: QueryClient) => ({
    detail: qc.getQueryData<SessionHistory>(sessionQueryKey("chs_1"))?.restricted,
    row: qc.getQueryData<SessionsCache>(sessionsQueryKey("spc_a"))?.pages[0]?.data[0]?.restricted,
  });

  it("PATCHes `restricted` and updates the detail and the list rows at once", async () => {
    const qc = seeded();
    const request = requestAnswering(() => new Response(null, { status: 204 }));
    const shown: boolean[] = [];

    const pending = changeLimit({
      queryClient: qc,
      transport: transportOver(request),
      id: "chs_1",
      next: true,
      previous: false,
      show: (value) => shown.push(value),
    });
    // Optimistic: the caches already say so before the server answered.
    expect(restrictedOf(qc)).toEqual({ detail: true, row: true });
    await pending;

    expect(request.calls).toHaveLength(1);
    expect(request.calls[0]!.path).toBe("/api/orgs/org_1/chat/sessions/chs_1");
    expect(request.calls[0]!.init?.method).toBe("PATCH");
    expect(JSON.parse(String(request.calls[0]!.init?.body))).toEqual({ restricted: true });
    expect(shown).toEqual([true]);
    expect(restrictedOf(qc)).toEqual({ detail: true, row: true });
  });

  it("rolls back everything when the server refuses, and rethrows", async () => {
    const qc = seeded();
    const request = requestAnswering(() => new Response(null, { status: 400 }));
    const shown: boolean[] = [];

    await expect(
      changeLimit({
        queryClient: qc,
        transport: transportOver(request),
        id: "chs_1",
        next: true,
        previous: false,
        show: (value) => shown.push(value),
      }),
    ).rejects.toBeDefined();

    expect(shown).toEqual([true, false]);
    expect(restrictedOf(qc)).toEqual({ detail: false, row: false });
  });
});

describe("a limited conversation's tool calls", () => {
  it("carry no space_id: the card falls back to the origin space", () => {
    const limited = { originSpaceId: "spc_a", restricted: true };
    expect(callSpace(undefined, limited)).toBe("spc_a");
    expect(pinnedSpaceOf(limited)).toBe("spc_a");
  });

  it("keep the space a call named, and name none on an unlimited conversation", () => {
    expect(callSpace("spc_b", { originSpaceId: "spc_a", restricted: true })).toBe("spc_b");
    expect(callSpace(undefined, { originSpaceId: "spc_a", restricted: false })).toBeUndefined();
    expect(pinnedSpaceOf({ originSpaceId: null, restricted: true })).toBeUndefined();
  });
});

describe("the composer's limit chip", () => {
  const host: ChatHost = {
    openFile: () => {},
    downloadFile: () => {},
    useFileImageSrc: () => null,
    t: (key, options) => (options ? `${key}|${String(options.name)}` : key),
    can: () => true,
    actingSpaceIds: ["spc_a"],
    personalModelCredentials: true,
    modelCredentials: [],
    formatBytes: String,
    onPackagesChanged: () => {},
    renderSpaces: (ids) => <i data-spaces={ids.join(",")}>Studio</i>,
  };

  function html(scope: ConversationScope): string {
    return renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ChatHostProvider value={host}>
          <ConversationScopeProvider value={scope}>
            <TooltipProvider>
              <ComposerTools
                transport={transportOf(() => ({}))}
                selection={{ skillMode: "auto", pinnedSkills: [] }}
                onSelectionChange={() => {}}
                showPicker={false}
                authorsPackages={false}
                showEnforced={false}
              />
            </TooltipProvider>
          </ConversationScopeProvider>
        </ChatHostProvider>
      </QueryClientProvider>,
    );
  }

  it("names the space and offers to lift the limit when the conversation is limited", () => {
    const out = html({ originSpaceId: "spc_a", restricted: true, setRestricted: () => {} });
    expect(out).toContain('data-testid="composer-limit-chip"');
    expect(out).toContain('data-spaces="spc_a"');
    expect(out).toContain('aria-label="composer.limit.undo"');
  });

  it("is absent when the conversation is not limited", () => {
    expect(
      html({ originSpaceId: "spc_a", restricted: false, setRestricted: () => {} }),
    ).not.toContain("composer-limit-chip");
  });
});
