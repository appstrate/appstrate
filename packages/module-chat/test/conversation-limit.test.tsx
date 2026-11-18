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
  ConversationScopeProvider,
  limitAvailability,
  limitedSpaceOf,
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

/** The assistant-ui runtime the attach button reads. */
function Runtime({ children }: { children: ReactNode }) {
  const runtime = useLocalRuntime({ run: async () => ({ content: [] }) });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

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

  it("decides the entry from the scope and the acting set", () => {
    const cases: [ReturnType<typeof scope>, string[] | null, unknown][] = [
      // An origin: one click while the chat acts there, never another space instead.
      [scope("spc_a"), ["spc_a", "spc_b"], { kind: "toggle", spaceId: "spc_a" }],
      [scope("spc_x"), ["spc_a", "spc_b"], { kind: "unavailable", reason: "outside" }],
      // No origin: the one acting space, else a choice among them, else none.
      [scope(null), ["spc_a"], { kind: "toggle", spaceId: "spc_a" }],
      [scope(null), ["spc_a", "spc_b"], { kind: "choose", spaceIds: ["spc_a", "spc_b"] }],
      [scope(null), [], { kind: "unavailable", reason: "no-acting-space" }],
      // A limited conversation can always be released.
      [scope("spc_x", true), [], { kind: "toggle", spaceId: "spc_x" }],
      [scope("spc_x", true), null, { kind: "toggle", spaceId: "spc_x" }],
      // No reason while the acting set is not known.
      [scope("spc_a"), null, { kind: "unavailable", reason: null }],
      [scope(null), null, { kind: "unavailable", reason: null }],
    ];
    for (const [s, acting, expected] of cases) {
      expect(limitAvailability(s, acting)).toEqual(expected as never);
    }
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

describe("changing the limit of a conversation created in this mount", () => {
  it("shows the pending limit though no list holds it yet", () => {
    const qc = new QueryClient();
    const transport = transportOver(() => new Promise<Response>(() => {}));
    let seen!: ConversationScope;
    const steps: Array<(scope: ConversationScope, getCreation: () => unknown) => void> = [
      (_, getCreation) => getCreation(),
      (scope) => scope.limitTo("spc_b"),
    ];
    function Harness() {
      const [, rerender] = useState(0);
      const limit = useConversationLimit({
        id: "chs_new",
        transport,
        persistedAtMount: false,
        stored: undefined,
        selectedSpaceId: undefined,
        generating: false,
      });
      seen = limit.scope;
      const step = steps.shift();
      if (step) {
        step(limit.scope, limit.getCreation);
        rerender((n) => n + 1);
      }
      return null;
    }
    renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <Harness />
      </QueryClientProvider>,
    );
    expect(seen).toMatchObject({ originSpaceId: "spc_b", restricted: true, pending: true });
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
  type Step = [selected: string | undefined, act: ((scope: ConversationScope) => void) | null];

  /**
   * The draft's limit after `steps`, each run on a render under the space it names as selected
   * (`undefined`: « Tous les espaces ») and acting on the scope that render shows. A state update
   * of the rendering component re-renders it at once, even statically.
   */
  function across(steps: Step[]): ReturnType<typeof useConversationLimit> {
    let seen: ReturnType<typeof useConversationLimit> | undefined;
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
      });
      const step = queue.shift();
      if (step) {
        step[1]?.(seen.scope);
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

  it("carries what the scope shows: limited where it starts, nothing from the overview", () => {
    expect(across([["spc_a", null]]).getCreation()).toEqual({ spaceId: "spc_a", restricted: true });
    expect(across([[undefined, null]]).getCreation()).toEqual({});
  });

  it("follows the choices made and the space selected before the first message", () => {
    const limitB = (s: ConversationScope) => s.limitTo("spc_b");
    const lift = (s: ConversationScope) => s.lift();
    const none = { originSpaceId: null, restricted: false };
    const cases: [string, Step[], { originSpaceId: string | null; restricted: boolean }][] = [
      ["started in a space", [["spc_a", null]], { originSpaceId: "spc_a", restricted: true }],
      ["started in the overview", [[undefined, null]], none],
      [
        "limited from the overview",
        [[undefined, limitB]],
        { originSpaceId: "spc_b", restricted: true },
      ],
      ["limited then lifted in the overview", [[undefined, (s) => (limitB(s), lift(s))]], none],
      ["lifted in a space", [["spc_a", lift]], { originSpaceId: "spc_a", restricted: false }],
      [
        "a space selected after a choice in the overview",
        [
          [undefined, limitB],
          ["spc_a", null],
        ],
        { originSpaceId: "spc_a", restricted: true },
      ],
      [
        "another space selected after a lift",
        [
          ["spc_a", lift],
          ["spc_c", null],
        ],
        { originSpaceId: "spc_c", restricted: true },
      ],
      [
        "back to the overview after a choice",
        [
          [undefined, limitB],
          ["spc_a", null],
          [undefined, null],
        ],
        none,
      ],
      [
        "the overview after a lift",
        [
          ["spc_a", lift],
          [undefined, null],
        ],
        none,
      ],
    ];
    for (const [name, steps, expected] of cases) {
      expect({ name, ...across(steps).scope }).toMatchObject({ name, ...expected });
    }
  });
});

describe("the composer's limit chip", () => {
  const host = testHost({
    t: (key, options) => (options ? `${key}|${String(options.name)}` : key),
    actingSpaceIds: ["spc_a"],
    renderSpaces: (ids) => <i data-spaces={ids.join(",")}>Studio</i>,
    useSpaceLabelOf: () => (id) => (id === "spc_a" ? "Studio" : undefined),
  });

  function html(scope: ConversationScope) {
    return renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ChatHostProvider value={host}>
          <ConversationScopeProvider value={scope}>
            <Runtime>
              <TooltipProvider>
                <ComposerTools
                  transport={transportOf(() => ({ "X-Space-Id": "spc_a" }))}
                  selection={{ skillMode: "auto", pinnedSkills: [] }}
                  onSelectionChange={() => {}}
                  showPicker={false}
                  authorsPackages={false}
                />
              </TooltipProvider>
            </Runtime>
          </ConversationScopeProvider>
        </ChatHostProvider>
      </QueryClientProvider>,
    );
  }

  it("names the space and offers to lift the limit when the conversation is limited", () => {
    const out = html(conversationScope({ originSpaceId: "spc_a", restricted: true }));
    expect(out).toContain('data-testid="composer-limit-chip"');
    expect(out).toContain('data-spaces="spc_a"');
    expect(out).not.toMatch(/aria-label="composer\.limit\.undo\|Studio" disabled/);
    expect(html(conversationScope({ originSpaceId: "spc_a" }))).not.toContain(
      "composer-limit-chip",
    );
  });

  it("cannot be lifted while a turn generates or a change is in flight", () => {
    for (const busy of [{ generating: true }, { pending: true }]) {
      const out = html(conversationScope({ originSpaceId: "spc_a", restricted: true, ...busy }));
      expect(out).toMatch(/aria-label="composer\.limit\.undo\|Studio" disabled=""/);
    }
  });

  it("says the generic sentence for a space the host cannot name, never « this space »", () => {
    const out = html(conversationScope({ originSpaceId: "spc_unseen", restricted: true }));
    expect(out).toContain("composer.limitChip.generic");
    expect(out).toContain('aria-label="composer.limit.undoGeneric"');
    expect(out).not.toContain("spc_unseen");
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

  it("toggle: limits in one click, naming the space", () => {
    const out = entry(conversationScope({ originSpaceId: "spc_a" }), ["spc_a", "spc_b"]);
    expect(out).toContain('role="menuitemcheckbox"');
    expect(out).toContain('aria-label="composer.limit|Studio"');
    expect(out).toContain('data-spaces="spc_a"');
    expect(out).not.toContain("data-choice");
  });

  it("choose: hands the host's sub-menu the acting spaces, a pick limiting there", () => {
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

  it("unavailable: inert, with its reason", () => {
    const out = entry(conversationScope({ originSpaceId: "spc_x" }), ["spc_a"]);
    expect(out).toContain('data-disabled=""');
    expect(out).toContain("composer.limit.outside");
    expect(out).not.toContain("data-choice");
  });
});

describe("the composer's attach button", () => {
  /** In « Tous les espaces » with several acting spaces: the destination is never asked. */
  function render(personalSpaceId: string | null) {
    const host = testHost({ actingSpaceIds: ["spc_a", "spc_b"], personalSpaceId });
    const transport = transportOf(() => ({}), null);
    return renderToStaticMarkup(
      <ChatHostProvider value={host}>
        <ChatTransportProvider value={transport}>
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
        </ChatTransportProvider>
      </ChatHostProvider>,
    );
  }

  it("opens the picker directly in a multi-space view, with no space question", () => {
    const out = render("spc_me");
    expect(out).toMatch(/<button[^>]*aria-label="composer.attach"/);
    expect(out).not.toMatch(/<button[^>]*disabled=""[^>]*aria-label="composer.attach"/);
    expect(out).not.toContain("composer.attach.choose");
  });

  it("is disabled until the personal space is known", () => {
    expect(render(null)).toMatch(/<button[^>]*disabled=""[^>]*aria-label="composer.attach"/);
  });
});
