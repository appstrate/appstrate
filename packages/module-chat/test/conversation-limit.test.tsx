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
import {
  DropdownMenu,
  DropdownMenuSub,
  DropdownMenuSubContent,
} from "@appstrate/ui/components/dropdown-menu";

import { changeLimit, creationFields, useConversationLimit } from "../src/ui/conversation-limit.ts";
import {
  ConversationScopeProvider,
  attachAvailability,
  useAttachAvailability,
  limitAvailability,
  limitedSpaceOf,
  type ConversationScope,
} from "../src/ui/conversation-scope.ts";
import { ComposerTools, LimitMenuEntry } from "../src/ui/composer-tools.tsx";
import { ChatHostProvider, type SpaceChoiceSubmenu } from "../src/ui/runtime-context.ts";
import {
  sessionQueryKey,
  sessionsQueryKey,
  type SessionHistory,
  type SessionsCache,
  type SessionSummary,
} from "../src/ui/sessions.ts";
import { requestAnswering, transportOf, transportOver } from "./fake-request.ts";
import { conversationScope, testHost } from "./test-host.ts";

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
  const scope = (originSpaceId: string | null, restricted = false, generating = false) => ({
    originSpaceId,
    restricted,
    generating,
  });

  it("limits a conversation with an origin to it, in one click, while the chat acts there", () => {
    expect(limitAvailability(scope("spc_a"), ["spc_a", "spc_b"])).toEqual({
      kind: "toggle",
      spaceId: "spc_a",
    });
  });

  it("limits a conversation without an origin to the one space the chat acts in, in one click", () => {
    expect(limitAvailability(scope(null), ["spc_a"])).toEqual({ kind: "toggle", spaceId: "spc_a" });
  });

  it("asks a conversation without an origin which space, among those the chat acts in", () => {
    expect(limitAvailability(scope(null), ["spc_a", "spc_b"])).toEqual({
      kind: "choose",
      spaceIds: ["spc_a", "spc_b"],
    });
  });

  it("is « no-acting-space » for a conversation without an origin when the chat acts nowhere", () => {
    expect(limitAvailability(scope(null), [])).toEqual({
      kind: "unavailable",
      reason: "no-acting-space",
    });
  });

  it("is « outside » when the origin space left the acting set, never another space instead", () => {
    expect(limitAvailability(scope("spc_x"), ["spc_a", "spc_b"])).toEqual({
      kind: "unavailable",
      reason: "outside",
    });
  });

  it("is « generating » while a turn generates, even to release the limit (the server refuses)", () => {
    for (const restricted of [false, true]) {
      for (const origin of ["spc_a", "spc_x", null]) {
        for (const acting of [[], ["spc_a"], ["spc_a", "spc_b"]]) {
          expect(limitAvailability(scope(origin, restricted, true), acting)).toEqual({
            kind: "unavailable",
            reason: "generating",
          });
        }
      }
    }
  });

  it("always lets a limited conversation be released", () => {
    expect(limitAvailability(scope("spc_x", true), [])).toEqual({
      kind: "toggle",
      spaceId: "spc_x",
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
  const originOf = (qc: QueryClient) => {
    const detail = qc.getQueryData<SessionHistory>(sessionQueryKey("org_1", "chs_1"));
    const listed = qc.getQueryData<SessionsCache>(sessionsQueryKey("spc_a"))?.pages[0]?.data[0];
    return {
      detail: { spaceId: detail?.spaceId, restricted: detail?.restricted, ids: detail?.space_ids },
      row: { spaceId: listed?.spaceId, restricted: listed?.restricted, ids: listed?.space_ids },
    };
  };
  const ORIGIN_A = { spaceId: "spc_a", restricted: false };

  it("PATCHes `restricted` and updates the detail and the list rows at once", async () => {
    const qc = seeded();
    const request = requestAnswering(() => new Response(null, { status: 204 }));
    const shown: boolean[] = [];

    const pending = changeLimit({
      queryClient: qc,
      transport: transportOver(request),
      id: "chs_1",
      next: { spaceId: "spc_a", restricted: true },
      previous: ORIGIN_A,
      show: (value) => shown.push(value.restricted),
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
        next: { spaceId: "spc_a", restricted: true },
        previous: ORIGIN_A,
        show: (value) => shown.push(value.restricted),
      }),
    ).rejects.toBeDefined();

    expect(shown).toEqual([true, false]);
    expect(restrictedOf(qc)).toEqual({ detail: false, row: false });
  });

  describe("giving a conversation without an origin the space it is limited to", () => {
    function seededWithoutOrigin(spaceIds: string[]) {
      const qc = new QueryClient();
      const none = { spaceId: null, restricted: false, space_ids: spaceIds };
      qc.setQueryData<SessionHistory | null>(sessionQueryKey("org_1", "chs_1"), {
        ...history,
        ...none,
      });
      qc.setQueryData<SessionsCache>(sessionsQueryKey("spc_a"), {
        pages: [{ data: [{ ...row, ...none }], hasMore: false }],
        pageParams: [undefined],
      });
      return qc;
    }
    const NONE = { spaceId: null, restricted: false };
    const LIMITED_B = { spaceId: "spc_b", restricted: true };

    it("PATCHes `spaceId` with the limit and shows the origin first at once", async () => {
      const qc = seededWithoutOrigin(["spc_a"]);
      const request = requestAnswering(() => new Response(null, { status: 204 }));
      const shown: unknown[] = [];
      const pending = changeLimit({
        queryClient: qc,
        transport: transportOver(request),
        id: "chs_1",
        next: LIMITED_B,
        previous: NONE,
        show: (value) => shown.push(value),
      });
      const optimistic = { spaceId: "spc_b", restricted: true, ids: ["spc_b", "spc_a"] };
      expect(originOf(qc)).toEqual({ detail: optimistic, row: optimistic });
      await pending;
      expect(JSON.parse(String(request.calls[0]!.init?.body))).toEqual({
        restricted: true,
        spaceId: "spc_b",
      });
      expect(shown).toEqual([LIMITED_B]);
      expect(originOf(qc)).toEqual({ detail: optimistic, row: optimistic });
    });

    it("rolls the origin back on a refusal, dropping only the space it added", async () => {
      for (const touched of [["spc_a"], ["spc_a", "spc_b"]]) {
        const qc = seededWithoutOrigin(touched);
        const shown: unknown[] = [];
        await expect(
          changeLimit({
            queryClient: qc,
            transport: transportOver(requestAnswering(() => new Response(null, { status: 409 }))),
            id: "chs_1",
            next: LIMITED_B,
            previous: NONE,
            show: (value) => shown.push(value),
          }),
        ).rejects.toBeDefined();
        expect(shown).toEqual([LIMITED_B, NONE]);
        const restored = { spaceId: null, restricted: false };
        const state = originOf(qc);
        expect(state.detail).toMatchObject(restored);
        expect(state.row).toMatchObject(restored);
        // A space touched before the limit stays listed; one only the limit added does not.
        expect([...state.row.ids!].sort()).toEqual([...touched].sort());
        expect([...state.detail.ids!].sort()).toEqual([...touched].sort());
      }
    });

    it("never sends `spaceId` for a conversation that has its origin", async () => {
      const qc = seeded();
      const request = requestAnswering(() => new Response(null, { status: 204 }));
      await changeLimit({
        queryClient: qc,
        transport: transportOver(request),
        id: "chs_1",
        next: { spaceId: "spc_a", restricted: false },
        previous: { spaceId: "spc_a", restricted: true },
        show: () => {},
      });
      expect(JSON.parse(String(request.calls[0]!.init?.body))).toEqual({ restricted: false });
    });
  });
});

describe("the space a limited conversation acts in", () => {
  it("pins the origin only while the conversation is limited", () => {
    expect(limitedSpaceOf({ originSpaceId: "spc_a", restricted: true })).toBe("spc_a");
    expect(limitedSpaceOf({ originSpaceId: "spc_a", restricted: false })).toBeUndefined();
    expect(limitedSpaceOf({ originSpaceId: null, restricted: true })).toBeUndefined();
  });
});

describe("a new conversation's default limit", () => {
  /**
   * The hook of a conversation not created yet, after `act` ran on its scope (render phase). A
   * static render runs no effect, so `getCreation` is read only without `act`; after one, what
   * the first message would carry is read off the scope, which is what `getCreation` freezes.
   */
  function draft(
    selectedSpaceId: string | undefined,
    act?: (scope: ConversationScope) => void,
  ): ReturnType<typeof useConversationLimit> {
    let seen: ReturnType<typeof useConversationLimit> | undefined;
    const steps = act ? [act] : [];
    function Harness() {
      seen = useConversationLimit({
        id: "chs_new",
        transport: undefined,
        persistedAtMount: false,
        stored: undefined,
        selectedSpaceId,
        generating: false,
      });
      // A state update of the rendering component re-renders it at once, even statically.
      const step = steps.shift();
      if (step) step(seen.scope);
      return null;
    }
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <Harness />
      </QueryClientProvider>,
    );
    return seen!;
  }

  const carried = (scope: ConversationScope) =>
    creationFields({ spaceId: scope.originSpaceId, restricted: scope.restricted });

  it("is limited to the space it is started in", () => {
    const limit = draft("spc_a");
    expect(limit.scope).toMatchObject({ originSpaceId: "spc_a", restricted: true });
    expect(limit.getCreation()).toEqual({ spaceId: "spc_a", restricted: true });
  });

  it("is unlimited from the overview, which has no origin until one is chosen", () => {
    const limit = draft(undefined);
    expect(limit.scope).toMatchObject({ originSpaceId: null, restricted: false });
    expect(limit.getCreation()).toEqual({});
  });

  it("takes the space chosen from the overview as its origin, limited there, with no request", () => {
    const limit = draft(undefined, (scope) => scope.limitTo("spc_b"));
    expect(limit.scope).toMatchObject({ originSpaceId: "spc_b", restricted: true });
    expect(carried(limit.scope)).toEqual({ spaceId: "spc_b", restricted: true });
  });

  it("is back to no origin when the chosen limit is undone before sending", () => {
    const limit = draft(undefined, (scope) => {
      scope.limitTo("spc_b");
    });
    const undone = draft(undefined, (scope) => {
      scope.limitTo("spc_b");
      scope.lift();
    });
    expect(limit.scope.originSpaceId).toBe("spc_b");
    expect(undone.scope).toMatchObject({ originSpaceId: null, restricted: false });
    expect(carried(undone.scope)).toEqual({});
  });

  it("keeps its origin when the limit is lifted in a space, and sends it unlimited", () => {
    const limit = draft("spc_a", (scope) => scope.lift());
    expect(limit.scope).toMatchObject({ originSpaceId: "spc_a", restricted: false });
    expect(carried(limit.scope)).toEqual({ spaceId: "spc_a" });
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
    const out = html(conversationScope({ originSpaceId: "spc_a", restricted: true }));
    expect(out).toContain('data-testid="composer-limit-chip"');
    expect(out).toContain('data-spaces="spc_a"');
    expect(out).toContain('aria-label="composer.limit.undo|Studio"');
    expect(out).not.toMatch(/aria-label="composer\.limit\.undo\|Studio" disabled/);
  });

  it("cannot be lifted while a turn generates", () => {
    const out = html(
      conversationScope({ originSpaceId: "spc_a", restricted: true, generating: true }),
    );
    expect(out).toMatch(/aria-label="composer\.limit\.undo\|Studio" disabled=""/);
  });

  it("disables the chip's X and the menu item while a change is in flight", () => {
    const out = html(
      conversationScope({ originSpaceId: "spc_a", restricted: true, pending: true }),
    );
    expect(out).toMatch(/aria-label="composer\.limit\.undo\|Studio" disabled=""/);
  });

  it("is absent when the conversation is not limited", () => {
    expect(html(conversationScope({ originSpaceId: "spc_a" }))).not.toContain(
      "composer-limit-chip",
    );
  });
});

describe("the composer's limit entry", () => {
  const picked: string[] = [];
  // The host's sub-menu of spaces, drawn as a marker naming what it was handed.
  const HostSubmenu: SpaceChoiceSubmenu = ({ label, spaceIds, onPick, testId }) => {
    onPick("spc_probe");
    return <u data-testid={testId} data-label={label} data-choice={spaceIds.join(",")} />;
  };
  const names: Record<string, string> = { spc_a: "Studio", spc_b: "Atelier" };

  function entry(scope: ConversationScope, actingSpaceIds: string[]) {
    const host = testHost({
      t: (key, options) => (options ? `${key}|${String(options.name)}` : key),
      actingSpaceIds,
      renderSpaces: (ids) => <i data-spaces={ids.join(",")}>{names[ids[0]!]}</i>,
      useSpaceLabelOf: () => (id) => (id ? names[id] : undefined),
      SpaceChoiceSubmenu: HostSubmenu,
    });
    // A sub-menu's content renders without a portal: the entry is drawn as the open menu draws it.
    return renderToStaticMarkup(
      <ChatHostProvider value={host}>
        <ConversationScopeProvider value={scope}>
          <DropdownMenu open>
            <DropdownMenuSub open>
              <DropdownMenuSubContent forceMount>
                <LimitMenuEntry />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenu>
        </ConversationScopeProvider>
      </ChatHostProvider>,
    );
  }

  it("limits a conversation with an origin to it in one click, naming it", () => {
    const out = entry(conversationScope({ originSpaceId: "spc_a" }), ["spc_a", "spc_b"]);
    expect(out).toContain('role="menuitemcheckbox"');
    expect(out).toContain('aria-label="composer.limit|Studio"');
    expect(out).toContain('data-spaces="spc_a"');
    expect(out).not.toContain("data-choice");
  });

  it("names the one space the chat acts in for a conversation without an origin", () => {
    const out = entry(conversationScope(), ["spc_b"]);
    expect(out).toContain('role="menuitemcheckbox"');
    expect(out).toContain('aria-label="composer.limit|Atelier"');
    expect(out).toContain('data-spaces="spc_b"');
  });

  it("hands the host's sub-menu the acting spaces, a pick limiting there", () => {
    picked.length = 0;
    const out = entry(conversationScope({ limitTo: (spaceId) => picked.push(spaceId) }), [
      "spc_a",
      "spc_b",
    ]);
    expect(out).toContain('data-testid="composer-limit-item"');
    expect(out).toContain('data-label="composer.limit.choose"');
    expect(out).toContain('data-choice="spc_a,spc_b"');
    expect(out).not.toContain('role="menuitemcheckbox"');
    expect(picked).toEqual(["spc_probe"]);
  });

  it("is inert with its reason otherwise", () => {
    const cases: [ConversationScope, string[], string][] = [
      [conversationScope({ generating: true }), ["spc_a", "spc_b"], "composer.limit.generating"],
      [conversationScope(), [], "composer.limit.noActingSpace"],
      [conversationScope({ originSpaceId: "spc_x" }), ["spc_a"], "composer.limit.outside"],
    ];
    for (const [scope, acting, reason] of cases) {
      const out = entry(scope, acting);
      expect(out).toContain('data-disabled=""');
      expect(out).toContain(reason);
      expect(out).not.toContain("data-choice");
    }
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
            value={conversationScope({ originSpaceId: "spc_a", restricted: true })}
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
