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
            <TooltipProvider>
              <ComposerTools
                transport={transportOf(() => ({ "X-Space-Id": "spc_a" }))}
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
    expect(out).not.toMatch(/aria-label="composer\.limit\.undo\|Studio" disabled/);
    expect(html(conversationScope({ originSpaceId: "spc_a" }))).not.toContain(
      "composer-limit-chip",
    );
  });

  it("hides every tool after attach while a phone's composer rests", () => {
    const out = html(conversationScope({ originSpaceId: "spc_a", restricted: true }));
    // The markup escapes the `&` and `>` of the arbitrary variant.
    expect(out).toContain("max-md:group-data-[rest]/composer:[&amp;&gt;:not(:first-child)]:hidden");
    // Attach is the cluster's first child; settings and the chip come after it.
    const cluster = out.slice(out.indexOf("max-md:group-data-[rest]/composer"));
    expect(cluster.indexOf('aria-label="composer.attach"')).toBeLessThan(
      cluster.indexOf('data-testid="composer-settings-trigger"'),
    );
    expect(cluster.indexOf('data-testid="composer-settings-trigger"')).toBeLessThan(
      cluster.indexOf('data-testid="composer-limit-chip"'),
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

describe("the space a file is attached in", () => {
  const unlimited = (originSpaceId: string | null) => ({ originSpaceId, restricted: false });
  const limited = (originSpaceId: string) => ({ originSpaceId, restricted: true });
  const acting = ["spc_a", "spc_b"];

  it("is the origin while the chat acts there, limited or not, whatever space is shown", () => {
    for (const shown of ["spc_a", "spc_b", null]) {
      for (const scope of [limited("spc_a"), unlimited("spc_a")]) {
        expect(attachAvailability(scope, acting, shown)).toEqual({
          kind: "attach",
          spaceId: "spc_a",
        });
      }
    }
  });

  it("decides the other cases from the space shown and the acting set", () => {
    const cases: [Parameters<typeof attachAvailability>, AttachAvailability][] = [
      // A limited conversation whose origin left the acting set takes no file.
      [[limited("spc_x"), acting, "spc_a"], { kind: "unavailable", reason: "origin-outside" }],
      // Without an origin, or off one left behind: the space shown, when the chat acts there.
      [[unlimited(null), acting, "spc_b"], { kind: "attach", spaceId: "spc_b" }],
      [[unlimited("spc_x"), acting, "spc_b"], { kind: "attach", spaceId: "spc_b" }],
      [[unlimited(null), acting, "spc_z"], { kind: "unavailable", reason: "outside" }],
      [[unlimited("spc_x"), acting, "spc_z"], { kind: "unavailable", reason: "outside" }],
      // « Tous les espaces »: the one acting space, else a choice, never the hidden one.
      [[unlimited(null), ["spc_a"], null], { kind: "attach", spaceId: "spc_a" }],
      [[unlimited(null), acting, null], { kind: "choose", spaceIds: acting }],
      [[unlimited(null), [], null], { kind: "unavailable", reason: "no-acting-space" }],
      // No reason while the acting set is not known.
      [[unlimited(null), null, null], { kind: "unavailable", reason: null }],
      [[limited("spc_a"), null, "spc_a"], { kind: "unavailable", reason: null }],
    ];
    for (const [args, expected] of cases) expect(attachAvailability(...args)).toEqual(expected);
  });

  it("goes where it is decided, else where last picked while that is a choice", () => {
    const choose: AttachAvailability = { kind: "choose", spaceIds: acting };
    expect(attachSpaceOf({ kind: "attach", spaceId: "spc_a" }, "spc_b")).toBe("spc_a");
    expect(attachSpaceOf(choose, "spc_b")).toBe("spc_b");
    expect(attachSpaceOf(choose, null)).toBeNull();
    expect(attachSpaceOf(choose, "spc_z")).toBeNull();
    expect(attachSpaceOf({ kind: "unavailable", reason: "outside" }, "spc_a")).toBeNull();
  });

  /** The target's space after each render's step; `scope` and the space shown are its state. */
  function targetAcross(
    steps: Array<
      (
        target: ReturnType<typeof useConversationAttachTarget>,
        set: {
          shown: (spaceId: string | null) => void;
          scope: (scope: ReturnType<typeof unlimited>) => void;
        },
      ) => void
    >,
  ): string | null {
    let destination: string | null = null;
    const queue = [...steps];
    function Composer() {
      const [shown, setShown] = useState<string | null>(null);
      const [scope, setScope] = useState(unlimited(null));
      const target = useConversationAttachTarget(scope, shown);
      destination = target.spaceId;
      queue.shift()?.(target, { shown: setShown, scope: setScope });
      return null;
    }
    renderToStaticMarkup(
      <ChatHostProvider value={testHost({ actingSpaceIds: acting })}>
        <Composer />
      </ChatHostProvider>,
    );
    return destination;
  }

  it("forgets a pick once the choice it answered is gone", () => {
    // Leaving the overview and coming back.
    expect(
      targetAcross([
        (t) => t.pick("spc_b"),
        (_, set) => set.shown("spc_a"),
        (_, set) => set.shown(null),
      ]),
    ).toBeNull();
    // Limited to another space (the origin then decides), then the limit lifted with no origin.
    expect(
      targetAcross([
        (t) => t.pick("spc_b"),
        (_, set) => set.scope({ originSpaceId: "spc_a", restricted: true }),
        (_, set) => set.scope(unlimited(null)),
      ]),
    ).toBeNull();
  });

  it("forgets a pick once the turn it was made for is sent", () => {
    expect(targetAcross([(t) => t.pick("spc_b"), (t) => t.forget()])).toBeNull();
  });

  it("is the space picked, then the origin once the conversation is limited there", () => {
    expect(targetAcross([(t) => t.pick("spc_b")])).toBe("spc_b");
    expect(
      targetAcross([
        (t) => t.pick("spc_b"),
        (_, set) => set.scope({ originSpaceId: "spc_a", restricted: true }),
      ]),
    ).toBe("spc_a");
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
    const spaceId = availability.kind === "attach" ? availability.spaceId : null;
    return renderToStaticMarkup(
      <ChatHostProvider value={host}>
        <ChatTransportProvider value={transport}>
          <AttachTargetProvider value={{ availability, spaceId, pick: () => {}, forget: () => {} }}>
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

  it("attach: directly, naming the destination only when it is not the space shown", () => {
    const here = render({ kind: "attach", spaceId: "spc_a" }, "spc_a");
    expect(here).toContain('aria-label="composer.attach"');
    expect(here).toContain('aria-label="composer.settings"');
    expect(here).not.toContain("data-choice");
    for (const shown of ["spc_b", null]) {
      expect(render({ kind: "attach", spaceId: "spc_a" }, shown)).toContain(
        'aria-label="composer.attachIn|Studio"',
      );
    }
    // A space the host cannot name is not named.
    expect(render({ kind: "attach", spaceId: "spc_unseen" }, null)).toContain(
      'aria-label="composer.attach"',
    );
  });

  it("choose: opens the acting spaces from the attach button itself", () => {
    const out = render({ kind: "choose", spaceIds: ["spc_a", "spc_b"] }, null);
    expect(out).toContain('data-variant="dropdown"');
    expect(out).toContain('data-label="composer.attach.choose"');
    expect(out).toContain('data-choice="spc_a,spc_b"');
    expect(out).toContain('aria-label="composer.attach"');
  });

  it("unavailable: disabled with the reason, and without one while the acting set loads", () => {
    const cases: [AttachAvailability, string | null][] = [
      [{ kind: "unavailable", reason: "origin-outside" }, "composer.limit.outside"],
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
