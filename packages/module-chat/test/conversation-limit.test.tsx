// SPDX-License-Identifier: Apache-2.0

/**
 * A conversation's origin space and limit: what its first message carries, when « Limiter à… » is
 * on offer, the PATCH that changes it (optimistic, rolled back), the chip, where a limited
 * conversation's tool calls are read, and the space a file is attached in.
 */

import { describe, expect, it } from "bun:test";
import { useState } from "react";
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
  AttachTargetProvider,
  ConversationScopeProvider,
  attachAvailability,
  attachSpaceOf,
  limitAvailability,
  limitedSpaceOf,
  type AttachAvailability,
  type ConversationScope,
} from "../src/ui/conversation-scope.ts";
import { AttachMenuEntry, ComposerTools, LimitMenuEntry } from "../src/ui/composer-tools.tsx";
import {
  ChatHostProvider,
  ChatTransportProvider,
  type SpaceChoiceSubmenu,
} from "../src/ui/runtime-context.ts";
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
    for (const acting of [[], null]) {
      expect(limitAvailability(scope("spc_x", true), acting)).toEqual({
        kind: "toggle",
        spaceId: "spc_x",
      });
    }
  });

  it("gives no reason while the acting set is not known", () => {
    for (const origin of ["spc_a", null]) {
      expect(limitAvailability(scope(origin), null)).toEqual({ kind: "unavailable", reason: null });
    }
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
        // Every copy is back as it was, in its order: a space touched before the limit stays
        // where it was listed, one only the limit added is gone.
        expect(state.row.ids).toEqual(touched);
        expect(state.detail.ids).toEqual(touched);
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

  /**
   * The draft's scope after `steps`, each run on a render under the space it names as selected
   * (`undefined`: « Tous les espaces ») and acting on the scope that render shows.
   */
  function across(
    steps: Array<[string | undefined, ((scope: ConversationScope) => void) | null]>,
  ): ConversationScope {
    let seen: ConversationScope | undefined;
    const queue = [...steps];
    function Harness() {
      const [selected, setSelected] = useState(queue[0]![0]);
      seen = useConversationLimit({
        id: "chs_new",
        transport: undefined,
        persistedAtMount: false,
        stored: undefined,
        selectedSpaceId: selected,
        generating: false,
      }).scope;
      // Each render takes its step, then selects the next step's space (a re-render, statically).
      const step = queue.shift();
      if (step) {
        step[1]?.(seen);
        const next = queue[0];
        if (next) setSelected(next[0]);
      }
      return null;
    }
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <Harness />
      </QueryClientProvider>,
    );
    return seen!;
  }

  it("drops a space chosen in « Tous les espaces » when a space is selected, taking that one", () => {
    const scope = across([
      [undefined, (s) => s.limitTo("spc_b")],
      ["spc_a", null],
    ]);
    expect(scope).toMatchObject({ originSpaceId: "spc_a", restricted: true });
  });

  it("drops a lifted limit when another space is selected, limited to the new one", () => {
    const scope = across([
      ["spc_a", (s) => s.lift()],
      ["spc_c", null],
    ]);
    expect(scope).toMatchObject({ originSpaceId: "spc_c", restricted: true });
  });

  it("is back to no origin when « Tous les espaces » is shown again", () => {
    const scope = across([
      ["spc_a", (s) => s.lift()],
      [undefined, null],
    ]);
    expect(scope).toMatchObject({ originSpaceId: null, restricted: false });
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

describe("the space a file is attached in", () => {
  const unlimited = (originSpaceId: string | null) => ({ originSpaceId, restricted: false });
  const limited = (originSpaceId: string) => ({ originSpaceId, restricted: true });
  const acting = ["spc_a", "spc_b"];

  it("is the origin while the chat acts there, limited or not, whatever space is shown", () => {
    for (const shown of ["spc_a", "spc_b", null]) {
      expect(attachAvailability(limited("spc_a"), acting, shown)).toEqual({
        kind: "attach",
        spaceId: "spc_a",
      });
      expect(attachAvailability(unlimited("spc_a"), acting, shown)).toEqual({
        kind: "attach",
        spaceId: "spc_a",
      });
    }
  });

  it("is none for a limited conversation whose origin left the acting set", () => {
    expect(attachAvailability(limited("spc_x"), acting, "spc_a")).toEqual({
      kind: "unavailable",
      reason: "origin-outside",
    });
  });

  it("is the selected space without an origin (or off an origin left behind), when the chat acts there", () => {
    for (const origin of [null, "spc_x"]) {
      expect(attachAvailability(unlimited(origin), acting, "spc_b")).toEqual({
        kind: "attach",
        spaceId: "spc_b",
      });
      expect(attachAvailability(unlimited(origin), acting, "spc_z")).toEqual({
        kind: "unavailable",
        reason: "outside",
      });
    }
  });

  it("in « Tous les espaces » without an origin: the one acting space, else a choice, never the hidden one", () => {
    expect(attachAvailability(unlimited(null), ["spc_a"], null)).toEqual({
      kind: "attach",
      spaceId: "spc_a",
    });
    expect(attachAvailability(unlimited(null), acting, null)).toEqual({
      kind: "choose",
      spaceIds: acting,
    });
    expect(attachAvailability(unlimited(null), [], null)).toEqual({
      kind: "unavailable",
      reason: "no-acting-space",
    });
  });

  it("gives no reason while the acting set is not known", () => {
    for (const scope of [unlimited(null), limited("spc_a")]) {
      for (const shown of ["spc_a", null]) {
        expect(attachAvailability(scope, null, shown)).toEqual({
          kind: "unavailable",
          reason: null,
        });
      }
    }
  });

  it("goes, for a file added without asking (a drop), where it is decided or last picked", () => {
    const choose: AttachAvailability = { kind: "choose", spaceIds: acting };
    expect(
      attachSpaceOf({ availability: { kind: "attach", spaceId: "spc_a" }, picked: "spc_b" }),
    ).toBe("spc_a");
    expect(attachSpaceOf({ availability: choose, picked: "spc_b" })).toBe("spc_b");
    expect(attachSpaceOf({ availability: choose, picked: null })).toBeNull();
    // A pick that is no longer among the choices counts for nothing.
    expect(attachSpaceOf({ availability: choose, picked: "spc_z" })).toBeNull();
    expect(
      attachSpaceOf({ availability: { kind: "unavailable", reason: "outside" }, picked: "spc_a" }),
    ).toBeNull();
  });
});

describe("the composer's attach entry", () => {
  const names: Record<string, string> = { spc_a: "Studio", spc_b: "Atelier" };
  // The host's sub-menu, drawn as a marker naming what it was handed (a pick opens a file picker).
  const HostSubmenu: SpaceChoiceSubmenu = ({ label, spaceIds, testId }) => (
    <u data-testid={testId} data-label={label} data-choice={spaceIds.join(",")} />
  );

  function entry(availability: AttachAvailability, shownSpaceId: string | null) {
    const host = testHost({
      t: (key, options) => (options ? `${key}|${String(options.name)}` : key),
      renderSpaces: (ids) => <i data-spaces={ids.join(",")}>{names[ids[0]!]}</i>,
      useSpaceLabelOf: () => (id) => (id ? names[id] : undefined),
      SpaceChoiceSubmenu: HostSubmenu,
    });
    return renderToStaticMarkup(
      <ChatHostProvider value={host}>
        <ChatTransportProvider value={transportOf(() => ({}), shownSpaceId)}>
          <AttachTargetProvider value={{ availability, picked: null, pick: () => {} }}>
            <DropdownMenu open>
              <DropdownMenuSub open>
                <DropdownMenuSubContent forceMount>
                  <AttachMenuEntry />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenu>
          </AttachTargetProvider>
        </ChatTransportProvider>
      </ChatHostProvider>,
    );
  }

  it("attaches in the space shown without naming it", () => {
    const out = entry({ kind: "attach", spaceId: "spc_a" }, "spc_a");
    expect(out).toContain("composer.attach<");
    expect(out).not.toContain("composer.attachIn");
  });

  it("names the space when it is not the one shown (an origin elsewhere, « Tous les espaces »)", () => {
    for (const shown of ["spc_b", null]) {
      const out = entry({ kind: "attach", spaceId: "spc_a" }, shown);
      expect(out).toContain('aria-label="composer.attachIn|Studio"');
      expect(out).toContain('data-spaces="spc_a"');
    }
  });

  it("asks which space through the host's sub-menu of the acting spaces", () => {
    const out = entry({ kind: "choose", spaceIds: ["spc_a", "spc_b"] }, null);
    expect(out).toContain('data-testid="composer-attach-item"');
    expect(out).toContain('data-label="composer.attach.choose"');
    expect(out).toContain('data-choice="spc_a,spc_b"');
  });

  it("is inert with its reason, and without one while the acting set loads", () => {
    const cases: [AttachAvailability, string | null][] = [
      [{ kind: "unavailable", reason: "outside" }, "composer.attachUnavailable"],
      [{ kind: "unavailable", reason: "origin-outside" }, "composer.limit.outside"],
      [{ kind: "unavailable", reason: "no-acting-space" }, "composer.limit.noActingSpace"],
      [{ kind: "unavailable", reason: null }, null],
    ];
    for (const [availability, reason] of cases) {
      const out = entry(availability, "spc_a");
      expect(out).toContain('data-disabled=""');
      if (reason) expect(out).toContain(reason);
      else expect(out).not.toContain("composer-attach-reason");
    }
  });
});
