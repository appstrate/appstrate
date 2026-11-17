// SPDX-License-Identifier: Apache-2.0

/**
 * A conversation's origin space and limit: what its first message carries, when « Limiter à… » is
 * on offer, the PATCH that changes it (optimistic, rolled back), the chip, where a limited
 * conversation's tool calls are read, and the space a file is attached in.
 */

import { describe, expect, it } from "bun:test";
import { useState, type ReactNode } from "react";
import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@appstrate/ui/components/tooltip";
import {
  DropdownMenu,
  DropdownMenuSub,
  DropdownMenuSubContent,
} from "@appstrate/ui/components/dropdown-menu";

import { creationFields, useConversationLimit } from "../src/ui/conversation-limit.ts";
import {
  AttachTargetProvider,
  ConversationScopeProvider,
  attachAvailability,
  attachSpaceOf,
  limitAvailability,
  useConversationAttachTarget,
  limitedSpaceOf,
  type AttachAvailability,
  type ConversationScope,
} from "../src/ui/conversation-scope.ts";
import { ComposerTools, LimitMenuEntry } from "../src/ui/composer-tools.tsx";
import {
  ChatHostProvider,
  ChatTransportProvider,
  type SpaceChoiceMenu,
} from "../src/ui/runtime-context.ts";
import {
  sessionQueryKey,
  sessionsQueryKey,
  type SessionHistory,
  type SessionsCache,
  type SessionSummary,
} from "../src/ui/sessions.ts";
import { useSessions, useSessionDetail } from "../src/ui/use-sessions.ts";
import { transportOf, transportOver } from "./fake-request.ts";
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
  function conversation(spaceId: string | null, touched: string[], restricted = false) {
    const qc = new QueryClient();
    const row: SessionSummary = {
      id: "chs_1",
      title: "Title",
      generating: false,
      unread: false,
      updatedAt: "",
      spaceId,
      restricted,
      space_ids: touched,
    };
    const detailKey = sessionQueryKey("org_1", row.id);
    const listKey = sessionsQueryKey("spc_a");
    function seed(changes: Partial<SessionSummary>) {
      qc.setQueryData<SessionHistory>(detailKey, {
        ...row,
        ...changes,
        messages: [],
        skills: { skillMode: "auto", pinnedSkills: [] },
        createdAt: "",
      });
      qc.setQueryData<SessionsCache>(listKey, {
        pages: [{ data: [{ ...row, ...changes }], hasMore: false }],
        pageParams: [undefined],
      });
    }
    seed({});
    const response = Promise.withResolvers<Response>();
    const requested = Promise.withResolvers<unknown>();
    const transport = transportOver(async (path, init) => {
      expect(path).toBe("/api/orgs/org_1/chat/sessions/chs_1");
      expect(init?.method).toBe("PATCH");
      requested.resolve(JSON.parse(String(init?.body)));
      const res = await response.promise;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    }, "spc_a");
    const settled = new Promise<void>((resolve) => {
      const off = qc.getMutationCache().subscribe(({ mutation }) => {
        if (mutation?.state.status === "success" || mutation?.state.status === "error") {
          off();
          resolve();
        }
      });
    });
    function read() {
      let scope!: ConversationScope;
      let copies!: Array<SessionSummary | undefined | null>;
      function Probe() {
        const list = useSessions().data?.[0];
        const detail = useSessionDetail(row.id).data;
        copies = [list, detail];
        scope = useConversationLimit({
          id: row.id,
          transport,
          persistedAtMount: true,
          stored: list,
          selectedSpaceId: undefined,
          generating: false,
        }).scope;
        return null;
      }
      renderToStaticMarkup(
        <QueryClientProvider client={qc}>
          <ChatTransportProvider value={transport}>
            <Probe />
          </ChatTransportProvider>
        </QueryClientProvider>,
      );
      return { scope, copies };
    }
    async function finish(status: number) {
      response.resolve(new Response(null, { status }));
      await settled;
    }
    return { read, seed, requested: requested.promise, finish };
  }

  it("shows the chosen origin on every reader before the server answers and keeps it on success", async () => {
    const c = conversation(null, ["spc_a"]);
    c.read().scope.limitTo("spc_b");
    expect(await c.requested).toEqual({ restricted: true, spaceId: "spc_b" });
    const limited = { spaceId: "spc_b", restricted: true, space_ids: ["spc_b", "spc_a"] };
    for (const copy of c.read().copies) expect(copy).toMatchObject(limited);
    await c.finish(204);
    for (const copy of c.read().copies) expect(copy).toMatchObject(limited);
  });

  it("preserves changes received during a refused PATCH, including the server's touched-space order", async () => {
    for (const touched of [["spc_a"], ["spc_a", "spc_b"]]) {
      const c = conversation(null, touched);
      c.read().scope.limitTo("spc_b");
      await c.requested;
      const newer = { title: "Renamed", space_ids: [...touched, "spc_c"] };
      c.seed(newer);
      for (const copy of c.read().copies) {
        expect(copy).toMatchObject({
          title: newer.title,
          restricted: true,
          space_ids: ["spc_b", "spc_a", "spc_c"],
        });
      }
      await c.finish(409);
      for (const copy of c.read().copies) {
        expect(copy).toMatchObject({ ...newer, spaceId: null, restricted: false });
      }
    }
  });

  it("sends only restricted for an existing origin and shows the stored limit on refusal", async () => {
    const c = conversation("spc_a", ["spc_a"], true);
    c.read().scope.lift();
    expect(await c.requested).toEqual({ restricted: false });
    for (const copy of c.read().copies) expect(copy?.restricted).toBe(false);
    await c.finish(400);
    for (const copy of c.read().copies) expect(copy?.restricted).toBe(true);
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
      const [selected, setSelected] = useState(steps[0]![0]);
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

  it("does not recover an abandoned choice when returning to the original view", () => {
    const scope = across([
      [undefined, (s) => s.limitTo("spc_b")],
      ["spc_a", null],
      [undefined, null],
    ]);
    expect(scope).toMatchObject({ originSpaceId: null, restricted: false });
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
  // The host's menu of spaces, drawn as a marker naming what it was handed.
  const HostSubmenu: SpaceChoiceMenu = ({ label, spaceIds, onPick, testId }) => {
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
      SpaceChoiceMenu: HostSubmenu,
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

  it("forgets a previous destination after leaving and returning to the overview", () => {
    let step = 0;
    let destination: string | null = null;
    function Composer() {
      const [shown, setShown] = useState<string | null>(null);
      const { target } = useConversationAttachTarget(unlimited(null), shown);
      destination = attachSpaceOf(target);
      switch (step++) {
        case 0:
          target.pick("spc_b");
          break;
        case 1:
          setShown("spc_a");
          break;
        case 2:
          setShown(null);
          break;
      }
      return null;
    }
    renderToStaticMarkup(
      <ChatHostProvider value={testHost({ actingSpaceIds: acting })}>
        <Composer />
      </ChatHostProvider>,
    );
    expect(destination).toBeNull();
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

describe("the composer's attach button", () => {
  const names: Record<string, string> = { spc_a: "Studio", spc_b: "Atelier" };
  const HostMenu: SpaceChoiceMenu = ({ variant, label, spaceIds, trigger }) => (
    <div data-variant={variant} data-label={label} data-choice={spaceIds.join(",")}>
      {trigger}
    </div>
  );

  function Runtime({ children }: { children: ReactNode }) {
    const runtime = useLocalRuntime({ run: async () => ({ content: [] }) });
    return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
  }

  function render(availability: AttachAvailability, shownSpaceId: string | null) {
    const host = testHost({
      t: (key, options) => (options ? `${key}|${String(options.name)}` : key),
      useSpaceLabelOf: () => (id) => (id ? names[id] : undefined),
      SpaceChoiceMenu: HostMenu,
    });
    const transport = transportOf(() => ({}), shownSpaceId);
    return renderToStaticMarkup(
      <ChatHostProvider value={host}>
        <ChatTransportProvider value={transport}>
          <AttachTargetProvider value={{ availability, picked: null, pick: () => {} }}>
            <Runtime>
              <TooltipProvider>
                <ComposerTools
                  transport={transport}
                  selection={{ skillMode: "auto", pinnedSkills: [] }}
                  onSelectionChange={() => {}}
                  showPicker={false}
                  authorsPackages={false}
                />
              </TooltipProvider>
            </Runtime>
          </AttachTargetProvider>
        </ChatTransportProvider>
      </ChatHostProvider>,
    );
  }

  it("attaches directly in the space shown without naming it, alongside the settings button", () => {
    const out = render({ kind: "attach", spaceId: "spc_a" }, "spc_a");
    expect(out).toContain('aria-label="composer.attach"');
    expect(out).toContain('aria-label="composer.settings"');
    expect(out).not.toContain("data-choice");
  });

  it("names a direct attachment's destination in another space or the overview", () => {
    for (const shown of ["spc_b", null]) {
      const out = render({ kind: "attach", spaceId: "spc_a" }, shown);
      expect(out).toContain('aria-label="composer.attachIn|Studio"');
      expect(out).not.toContain("data-choice");
    }
  });

  it("opens the acting spaces from the attach button itself", () => {
    const out = render({ kind: "choose", spaceIds: ["spc_a", "spc_b"] }, null);
    expect(out).toContain('data-variant="dropdown"');
    expect(out).toContain('data-label="composer.attach.choose"');
    expect(out).toContain('data-choice="spc_a,spc_b"');
    expect(out).toContain('aria-label="composer.attach"');
  });

  it("disables the button with the reason, and without one while the acting set loads", () => {
    const cases: [AttachAvailability, string | null][] = [
      [{ kind: "unavailable", reason: "outside" }, "composer.attachUnavailable"],
      [{ kind: "unavailable", reason: "origin-outside" }, "composer.limit.outside"],
      [{ kind: "unavailable", reason: "no-acting-space" }, "composer.limit.noActingSpace"],
      [{ kind: "unavailable", reason: null }, null],
    ];
    for (const [availability, reason] of cases) {
      const out = render(availability, "spc_a");
      expect(out).toMatch(/<button[^>]*disabled=""[^>]*aria-label="composer.attach"/);
      if (reason) expect(out).toContain(reason);
      else expect(out).not.toContain('class="sr-only"');
    }
  });
});
