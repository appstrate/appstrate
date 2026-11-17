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

import { changeLimit, creationFields, useConversationLimit } from "../src/ui/conversation-limit.ts";
import {
  callSpaceOf,
  ConversationScopeProvider,
  attachAvailability,
  useAttachAvailability,
  limitAvailability,
  limitedSpaceOf,
  type ConversationScope,
} from "../src/ui/conversation-scope.ts";
import { ComposerTools } from "../src/ui/composer-tools.tsx";
import { ChatHostProvider } from "../src/ui/runtime-context.ts";
import {
  sessionQueryKey,
  sessionsQueryKey,
  type SessionHistory,
  type SessionsCache,
  type SessionSummary,
} from "../src/ui/sessions.ts";
import { requestAnswering, transportOf, transportOver } from "./fake-request.ts";
import { testHost } from "./test-host.ts";

describe("what the first message carries", () => {
  it("is the origin space, and the limit only when it is on", () => {
    expect(creationFields({ spaceId: "spc_a", restricted: false })).toEqual({ spaceId: "spc_a" });
    expect(creationFields({ spaceId: "spc_a", restricted: true })).toEqual({
      spaceId: "spc_a",
      restricted: true,
    });
  });

  it("is nothing from « Tous les espaces », whatever was toggled", () => {
    expect(creationFields({ spaceId: null, restricted: false })).toEqual({});
    expect(creationFields({ spaceId: null, restricted: true })).toEqual({});
  });
});

describe("when the limit is on offer", () => {
  const acting = ["spc_a"];

  it("is when the conversation has an origin space the chat acts in", () => {
    expect(
      limitAvailability({ originSpaceId: "spc_a", restricted: false, generating: false }, acting),
    ).toEqual({
      available: true,
    });
  });

  it("is not in « Tous les espaces » or for a conversation without an origin", () => {
    expect(
      limitAvailability({ originSpaceId: null, restricted: false, generating: false }, acting),
    ).toEqual({
      available: false,
      reason: "no-space",
    });
  });

  it("is not when the origin space is outside the acting set", () => {
    expect(
      limitAvailability({ originSpaceId: "spc_x", restricted: false, generating: false }, acting),
    ).toEqual({
      available: false,
      reason: "outside",
    });
  });

  it("is not while a turn generates, even to release the limit (the server refuses)", () => {
    for (const restricted of [false, true]) {
      expect(
        limitAvailability({ originSpaceId: "spc_a", restricted, generating: true }, acting),
      ).toEqual({ available: false, reason: "generating" });
    }
  });

  it("is « outside », not « no-space », when the host works in a space the chat does not act in", () => {
    const none = { originSpaceId: null, restricted: false, generating: false };
    expect(limitAvailability(none, acting, "spc_x")).toEqual({
      available: false,
      reason: "outside",
    });
    // The overview keeps the entered space as working space: that one is acted in.
    expect(limitAvailability(none, acting, "spc_a")).toEqual({
      available: false,
      reason: "no-space",
    });
  });

  it("always lets a limited conversation be released", () => {
    expect(
      limitAvailability({ originSpaceId: "spc_x", restricted: true, generating: false }, acting),
    ).toEqual({
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
    ...row,
    messages: [],
    skills: { skillMode: "auto", pinnedSkills: [] },
    createdAt: "",
  };

  function seeded() {
    const qc = new QueryClient();
    qc.setQueryData<SessionHistory | null>(sessionQueryKey("org_1", "chs_1"), history);
    qc.setQueryData<SessionsCache>(sessionsQueryKey("spc_a"), {
      pages: [{ data: [row], hasMore: false }],
      pageParams: [undefined],
    });
    return qc;
  }
  const restrictedOf = (qc: QueryClient) => ({
    detail: qc.getQueryData<SessionHistory>(sessionQueryKey("org_1", "chs_1"))?.restricted,
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

describe("the space a tool card shows", () => {
  it("is the one the engine stamped on the call, whatever the conversation's limit is now", () => {
    const stamped = { providerMetadata: { appstrate: { spaceId: "spc_a" } } };
    expect(callSpaceOf(stamped)).toBe("spc_a");
  });

  it("is none for a call that acted in no space", () => {
    expect(callSpaceOf({})).toBeUndefined();
    expect(callSpaceOf({ providerMetadata: { appstrate: {} } })).toBeUndefined();
    expect(callSpaceOf({ providerMetadata: { appstrate: { spaceId: 4 } } })).toBeUndefined();
  });

  it("pins the origin only while the conversation is limited", () => {
    expect(limitedSpaceOf({ originSpaceId: "spc_a", restricted: true })).toBe("spc_a");
    expect(limitedSpaceOf({ originSpaceId: "spc_a", restricted: false })).toBeUndefined();
    expect(limitedSpaceOf({ originSpaceId: null, restricted: true })).toBeUndefined();
  });
});

describe("a new conversation's default limit", () => {
  function draft(selectedSpaceId: string | undefined) {
    let seen: ReturnType<typeof useConversationLimit> | undefined;
    function Harness() {
      seen = useConversationLimit({
        id: "chs_new",
        transport: undefined,
        persistedAtMount: false,
        stored: undefined,
        selectedSpaceId,
        generating: false,
      });
      return null;
    }
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <Harness />
      </QueryClientProvider>,
    );
    return seen!;
  }

  it("is limited to the space it is started in", () => {
    const limit = draft("spc_a");
    expect(limit.scope).toMatchObject({ originSpaceId: "spc_a", restricted: true });
    expect(limit.getCreation()).toEqual({ spaceId: "spc_a", restricted: true });
  });

  it("is unlimited from the overview, which has no space to limit to", () => {
    const limit = draft(undefined);
    expect(limit.scope).toMatchObject({ originSpaceId: null, restricted: false });
    expect(limit.getCreation()).toEqual({});
  });
});

describe("the composer's limit chip", () => {
  const host = testHost({
    t: (key, options) => (options ? `${key}|${String(options.name)}` : key),
    actingSpaceIds: ["spc_a"],
    renderSpaces: (ids) => <i data-spaces={ids.join(",")}>Studio</i>,
    useSpaceLabelOf: () => (id) => (id === "spc_a" ? "Studio" : undefined),
  });

  function html(scope: ConversationScope, workingSpaceId = "spc_a") {
    return renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ChatHostProvider value={host}>
          <ConversationScopeProvider value={scope}>
            <TooltipProvider>
              <ComposerTools
                transport={transportOf(() => ({ "X-Space-Id": workingSpaceId }))}
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
    const out = html({
      originSpaceId: "spc_a",
      restricted: true,
      generating: false,
      pending: false,
      setRestricted: () => {},
    });
    expect(out).toContain('data-testid="composer-limit-chip"');
    expect(out).toContain('data-spaces="spc_a"');
    expect(out).toContain('aria-label="composer.limit.undo|Studio"');
    expect(out).not.toMatch(/aria-label="composer\.limit\.undo\|Studio" disabled/);
  });

  it("cannot be lifted while a turn generates", () => {
    const out = html({
      originSpaceId: "spc_a",
      restricted: true,
      generating: true,
      pending: false,
      setRestricted: () => {},
    });
    expect(out).toMatch(/aria-label="composer\.limit\.undo\|Studio" disabled=""/);
  });

  it("disables the chip's X and the menu item while a change is in flight", () => {
    const out = html({
      originSpaceId: "spc_a",
      restricted: true,
      generating: false,
      pending: true,
      setRestricted: () => {},
    });
    expect(out).toMatch(/aria-label="composer\.limit\.undo\|Studio" disabled=""/);
  });

  it("is absent when the conversation is not limited", () => {
    expect(
      html({
        originSpaceId: "spc_a",
        restricted: false,
        generating: false,
        pending: false,
        setRestricted: () => {},
      }),
    ).not.toContain("composer-limit-chip");
  });
});

describe("attaching a file in a limited conversation", () => {
  it("is allowed only from the origin space", () => {
    const limited = { originSpaceId: "spc_a", restricted: true };
    const acting = ["spc_a", "spc_b"];
    expect(attachAvailability(acting, limited, "spc_a")).toEqual({ available: true });
    expect(attachAvailability(acting, limited, "spc_b")).toEqual({
      available: false,
      reason: "limited",
    });
    expect(attachAvailability(acting, limited, null)).toEqual({
      available: false,
      reason: "limited",
    });
  });

  it("is from any working space the chat acts in for an unlimited conversation", () => {
    const open = { originSpaceId: "spc_a", restricted: false };
    expect(attachAvailability(["spc_b"], open, "spc_b")).toEqual({ available: true });
    expect(attachAvailability(["spc_a"], open, "spc_b")).toEqual({
      available: false,
      reason: "outside",
    });
    expect(attachAvailability(["spc_a"], open, null)).toEqual({
      available: false,
      reason: "outside",
    });
    // On the origin but where the chat does not act.
    expect(attachAvailability([], { originSpaceId: "spc_a", restricted: true }, "spc_a")).toEqual({
      available: false,
      reason: "outside",
    });
  });
  it("reads the host's working space, not the list filter: opened in the overview, on its origin", () => {
    const host = testHost({ actingSpaceIds: ["spc_a"] });
    function Verdict() {
      const verdict = useAttachAvailability();
      return <b data-available={String(verdict.available)} />;
    }
    const render = (workingSpaceId: string | null) =>
      renderToStaticMarkup(
        // No transport is published: the overview's list filter is null whatever the working space.
        <ChatHostProvider value={{ ...host, workingSpaceId }}>
          <ConversationScopeProvider
            value={{
              originSpaceId: "spc_a",
              restricted: true,
              generating: false,
              pending: false,
              setRestricted: () => {},
            }}
          >
            <Verdict />
          </ConversationScopeProvider>
        </ChatHostProvider>,
      );
    expect(render("spc_a")).toContain('data-available="true"');
    expect(render("spc_b")).toContain('data-available="false"');
    expect(render(null)).toContain('data-available="false"');
  });
});
