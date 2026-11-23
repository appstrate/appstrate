// SPDX-License-Identifier: Apache-2.0

/**
 * The skills picker: the choosable skills are listed whether discovery is on or off, the
 * discovery switch reflects the selection, each pinned row is loaded or not loaded with its
 * reason, and a skill whose size would exceed the budget cannot be pinned. SSR only, the panel rendered
 * without the popover's portal.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@appstrate/ui/components/tooltip";

import { ChatHostProvider, ChatTransportProvider } from "../src/ui/runtime-context.ts";
import { ConversationScopeProvider } from "../src/ui/conversation-scope.ts";
import { SkillsPickerPanel } from "../src/ui/skills-picker.tsx";
import { transportOf } from "./fake-request.ts";
import { conversationScope, testHost } from "./test-host.ts";
import type { ReactElement, ReactNode } from "react";
import type { PinnedSkill } from "../src/skills.ts";
import { effectiveSkills, type EffectiveSkills, type StoredSkills } from "../src/ui/chat-skills.ts";
import type { ConversationSkillsState } from "../src/ui/use-conversation-skills.ts";

const host = testHost({
  actingSpaceIds: ["spc_a"],
  t: (key, options) => (options ? `${key} ${JSON.stringify(options)}` : key),
});

const transport = transportOf(() => ({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" }));

const userPin = (id: string): PinnedSkill => ({ id, status: "injected", chars: null });

const NO_ACTIONS: Pick<ConversationSkillsState, "setPin" | "setDiscovery"> = {
  setPin() {},
  setDiscovery() {},
};

/** The draft's skills over `stored`, as the composer computes them. */
const draftOf = (stored: StoredSkills, cited: string[]): EffectiveSkills =>
  effectiveSkills(
    stored.pins.map((pin) => pin.id),
    cited,
  );

/** Seeds the commands catalogue with `ids` (named by their id) at their `bytes`. */
function seedCatalogue(
  qc: QueryClient,
  ids: { id: string; name?: string }[],
  bytes: Record<string, number> = {},
): void {
  qc.setQueryData(["packages", "chat-commands", "org_1", null, true], {
    skills: ids.map(({ id, name }) => ({
      id,
      name: name ?? id,
      description: "",
      version: null,
      bytes: bytes[id] ?? null,
    })),
    agents: [],
  });
}

/** `children` under the providers the panel reads. */
function wrap(children: ReactNode, qc = new QueryClient()): ReactElement {
  return (
    <QueryClientProvider client={qc}>
      <ChatHostProvider value={host}>
        <ChatTransportProvider value={transport}>
          <ConversationScopeProvider
            value={conversationScope({ originSpaceId: "spc_a", restricted: false })}
          >
            {children}
          </ConversationScopeProvider>
        </ChatTransportProvider>
      </ChatHostProvider>
    </QueryClientProvider>
  );
}

/** A skill row's checkbox in `html`. */
const box = (html: string, id: string) =>
  html.match(new RegExp(`<button[^>]*data-testid="skill-pin-${id}"[^>]*>`))![0];

function render(
  skillDiscovery: boolean,
  pins: string[] | PinnedSkill[] = [],
  cited: string[] = [],
  /** Ids the catalogue does not list (dead pins). */
  unlisted: string[] = [],
  /** Listed sizes of the catalogue's skills, by id. */
  bytes: Record<string, number> = {},
): string {
  const stored: StoredSkills = {
    skillDiscovery,
    pins: pins.map((pin) => (typeof pin === "string" ? userPin(pin) : pin)),
  };
  const qc = new QueryClient();
  seedCatalogue(
    qc,
    [
      { id: "@acme/free", name: "Free" },
      ...[...stored.pins.map((pin) => pin.id), ...cited]
        .filter((id) => !unlisted.includes(id))
        .map((id) => ({ id })),
    ],
    bytes,
  );
  return renderToStaticMarkup(
    wrap(
      <TooltipProvider>
        <SkillsPickerPanel
          conversation={{ skills: stored, ...NO_ACTIONS }}
          draft={draftOf(stored, cited)}
        />
      </TooltipProvider>,
      qc,
    ),
  );
}

/** The first element under `node` whose props satisfy `match`. */
function findElement(node: ReactNode, match: (props: Record<string, unknown>) => boolean) {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, match);
      if (hit) return hit;
    }
    return undefined;
  }
  const el = node as ReactElement<Record<string, unknown>>;
  if (match(el.props ?? {})) return el;
  return findElement(el.props?.children as ReactNode, match);
}

/** Calls the discovery switch's change handler, with the panel's hooks run inside a render. */
function toggleDiscovery(skillDiscovery: boolean, next: boolean): boolean[] {
  const emitted: boolean[] = [];
  function Probe() {
    const tree = SkillsPickerPanel({
      conversation: {
        skills: { skillDiscovery, pins: [] },
        ...NO_ACTIONS,
        setDiscovery: (on) => emitted.push(on),
      },
      draft: draftOf({ skillDiscovery, pins: [] }, []),
    });
    const sw = findElement(
      tree,
      (props) => props["data-testid"] === "skills-discovery" && "onCheckedChange" in props,
    );
    (sw!.props.onCheckedChange as (checked: boolean) => void)(next);
    return null;
  }
  renderToStaticMarkup(wrap(<Probe />));
  return emitted;
}

describe("SkillsPicker", () => {
  it("hands the new discovery value to the conversation's changes", () => {
    expect(toggleDiscovery(true, false)).toEqual([false]);
    expect(toggleDiscovery(false, true)).toEqual([true]);
  });

  it("binds the discovery switch to its label, checked while discovery is on", () => {
    const sw = (html: string) => html.match(/<button[^>]*data-testid="skills-discovery"[^>]*>/)![0];
    expect(sw(render(true))).toContain('aria-checked="true"');
    expect(sw(render(false))).toContain('aria-checked="false"');
    // Its id is generated per panel: the label names the switch's.
    const html = render(true);
    const id = sw(html).match(/ id="([^"]+)"/)![1];
    expect(html).toContain(`for="${id}"`);
    expect(render(true)).toContain("skills.discovery.hintOn");
    expect(render(false)).toContain("skills.discovery.hintOff");
    // The choosable skills are listed whether discovery is on or off.
    expect(render(false)).toContain("skill-pin-@acme/free");
  });

  it("checks the pins alone: a skill the draft cites is neither checked nor locked", () => {
    const html = render(
      true,
      [{ id: "@a/auto", status: "injected", chars: null }],
      ["@acme/cited"],
    );
    expect(box(html, "@acme/cited")).toContain('aria-checked="false"');
    expect(box(html, "@acme/cited")).not.toContain(`aria-disabled="true"`);
    expect(html).not.toContain("skill-pin-state-@acme/cited");
    expect(box(html, "@a/auto")).toContain('aria-checked="true"');
  });

  /** Toggles each row of `ids` through the rendered tree; returns what the panel handed on (`±id`). */
  function toggleRows(
    pins: PinnedSkill[],
    cited: string[],
    ids: string[],
    bytes: Record<string, number> = {},
  ): string[] {
    const toggled: string[] = [];
    // Rows exist only once the catalogue answers: seed it, then toggle through the rendered tree.
    const qc = new QueryClient();
    seedCatalogue(
      qc,
      ids.map((id) => ({ id })),
      bytes,
    );
    function Toggle() {
      const tree = SkillsPickerPanel({
        conversation: {
          skills: { skillDiscovery: true, pins },
          ...NO_ACTIONS,
          setPin: (id, on) => toggled.push(`${on ? "+" : "-"}${id}`),
        },
        draft: draftOf({ skillDiscovery: true, pins }, cited),
      });
      for (const id of ids) {
        const box = findElement(tree, (props) => props["data-testid"] === `skill-pin-${id}`);
        (box!.props.onCheckedChange as () => void)();
      }
      return null;
    }
    renderToStaticMarkup(wrap(<Toggle />, qc));
    return toggled;
  }

  it("pins or unpins a cited skill like any other; its size is already counted", () => {
    expect(toggleRows([userPin("@a/one")], ["@a/one", "@a/two"], ["@a/one", "@a/two"])).toEqual([
      "-@a/one",
      "+@a/two",
    ]);
    const full: PinnedSkill = { id: "@a/own", status: "injected", chars: 60_000 };
    expect(toggleRows([full], ["@a/cited"], ["@a/cited"], { "@a/cited": 4_000 })).toEqual([
      "+@a/cited",
    ]);
  });

  it("pins past the estimated budget, lets every pin be unchecked (a refused one included), and pins an unknown size", () => {
    const full: PinnedSkill = { id: "@a/own", status: "injected", chars: 60_000 };
    const refused: PinnedSkill = { id: "@a/big", status: "over_budget", chars: null };
    const sizes = { "@a/extra": 5_000 };
    expect(
      toggleRows([full, refused], [], ["@a/extra", "@a/unsized", "@a/own", "@a/big"], sizes),
    ).toEqual(["+@a/extra", "+@a/unsized", "-@a/own", "-@a/big"]);
    expect(toggleRows([], [], ["@a/extra"], sizes)).toEqual(["+@a/extra"]);
  });

  it("names a row's checkbox by its skill alone; the caption and description describe it", () => {
    const html = render(true, [{ id: "@a/big", status: "over_budget", chars: null }]);
    const labelledBy = box(html, "@a/big").match(/aria-labelledby="([^"]+)"/)![1];
    const describedBy = box(html, "@a/big").match(/aria-describedby="([^"]+)"/)![1];
    expect(html).toMatch(new RegExp(`id="${labelledBy}"[^>]*>@a/big<`));
    const details = html.slice(html.indexOf(`id="${describedBy}"`));
    expect(details).toContain("skills.state.refused.over_budget");
    // A locked row is not `disabled`: it stays in the tab order, its reason read out.
    expect(render(true, [], ["@a/c"])).not.toMatch(
      /data-testid="skill-pin-@a\/c"[^>]* disabled=""/,
    );
  });

  describe("a pinned row is loaded, or not loaded and why", () => {
    const caption = (html: string, id: string) =>
      html.match(new RegExp(`data-testid="skill-pin-state-${id}"[^>]*>([^<]*)<`))?.[1];

    it("a pin no turn judged yet: checked, no caption, and ONE note that changes apply next message", () => {
      const html = render(true, [
        { id: "@a/one", status: null, chars: null },
        { id: "@a/two", status: null, chars: null },
      ]);
      expect(box(html, "@a/one")).toContain('aria-checked="true"');
      expect(caption(html, "@a/one")).toBeUndefined();
      expect(html.match(/data-testid="skills-pending-note"/g)).toHaveLength(1);
      expect(html).toContain("skills.pendingNote");
      expect(render(true, ["@a/mine"])).not.toContain("skills-pending-note");
    });

    it("the uncheck hint is said once for the panel, and only with a loaded pin", () => {
      const html = render(true, ["@a/one", "@a/two"]);
      expect(html.match(/data-testid="skills-uncheck-hint"/g)).toHaveLength(1);
      expect(render(true, [{ id: "@a/big", status: "over_budget", chars: 1 }])).not.toContain(
        "skills-uncheck-hint",
      );
      expect(render(true, [{ id: "@a/new", status: null, chars: null }])).not.toContain(
        "skills-uncheck-hint",
      );
      // A loaded pin the draft cites is still unchecked here.
      expect(render(true, ["@a/mine"], ["@a/mine"])).toContain("skills-uncheck-hint");
    });

    for (const status of ["injected", "over_budget", "unavailable", "unreadable"] as const) {
      const why = status === "injected" ? undefined : `skills.state.refused.${status}`;
      it(`a pin the last turn ${why ? `refused (${status}): not loaded and why` : "loaded: no caption"}, checked and enabled`, () => {
        const html = render(true, [{ id: "@a/ref", status, chars: null }]);
        expect(box(html, "@a/ref")).toContain('aria-checked="true"');
        expect(box(html, "@a/ref")).not.toContain(`aria-disabled="true"`);
        expect(caption(html, "@a/ref")).toBe(why);
      });
    }

    it("a cited pin the server refused gives the refusal and can be unchecked", () => {
      const html = render(true, [{ id: "@a/big", status: "over_budget", chars: 1 }], ["@a/big"]);
      expect(caption(html, "@a/big")).toBe("skills.state.refused.over_budget");
      expect(box(html, "@a/big")).not.toContain(`aria-disabled="true"`);
    });

    it("a refused pin the catalogue no longer lists gives its reason once", () => {
      const html = render(
        true,
        [{ id: "@a/gone", status: "unavailable", chars: null }],
        [],
        ["@a/gone"],
      );
      expect(caption(html, "@a/gone")).toBe("skills.state.refused.unavailable");
      expect(html).not.toContain("skills.unavailable");
    });
  });

  describe("the budget gauge", () => {
    const counts = (html: string) =>
      html.match(/skills\.budget\.counts[^<]*/)?.[0].replace(/&quot;/g, '"');

    it("warns on an available row whose size might exceed the budget, its reason describing the checkbox", () => {
      const html = render(true, [{ id: "@a/loaded", status: "injected", chars: 50_000 }], [], [], {
        "@acme/free": 20_000,
      });
      expect(html).toContain('data-testid="skill-pin-budget-@acme/free"');
      const free = box(html, "@acme/free");
      expect(free).not.toContain("aria-disabled");
      expect(free).not.toMatch(/ disabled=""/);
      const describedBy = free.match(/aria-describedby="([^"]+)"/)![1];
      expect(html.slice(html.indexOf(`id="${describedBy}"`))).toContain(
        "skills.budget.wouldExceed",
      );
      expect(render(true, [], [], [], { "@acme/free": 20_000 })).not.toContain("skill-pin-budget-");
    });

    it("says when the pins already exceed it", () => {
      const html = render(true, [{ id: "@a/new", status: null, chars: null }], [], [], {
        "@a/new": 70_000,
      });
      expect(counts(html)).toContain('"used":"70,000"');
      expect(counts(html)).toContain('"max":"64,000"');
      expect(html).toContain('data-over="true"');
      expect(html).toContain("skills.budget.over");
    });
  });
});
