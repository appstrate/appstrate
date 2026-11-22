// SPDX-License-Identifier: Apache-2.0

/**
 * The skills picker: the choosable skills are listed whether discovery is on or off, the
 * discovery switch reflects the selection, each pinned row is loaded or not loaded with its
 * reason, and the budget gauge warns before a pin would exceed it. SSR only, the panel rendered
 * without the popover's portal.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@appstrate/ui/components/tooltip";

import { ChatHostProvider } from "../src/ui/runtime-context.ts";
import { ConversationScopeProvider } from "../src/ui/conversation-scope.ts";
import { SkillsPickerPanel } from "../src/ui/skills-picker.tsx";
import { transportOf } from "./fake-request.ts";
import { conversationScope, testHost } from "./test-host.ts";
import type { ReactElement, ReactNode } from "react";
import { MAX_PINNED_SKILLS, type PinnedSkill } from "../src/skills.ts";
import { effectiveSkills, type StoredSkills } from "../src/ui/chat-skills.ts";
import type { ConversationSkillsState, DraftSkills } from "../src/ui/use-conversation-skills.ts";

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
const draftOf = (stored: StoredSkills, cited: string[]): DraftSkills => ({
  cited,
  effective: effectiveSkills(
    stored.pins.map((pin) => pin.id),
    cited,
  ),
});

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
  const skill = (id: string, name: string) => ({
    id,
    name,
    description: "",
    version: null,
    bytes: bytes[id] ?? null,
  });
  qc.setQueryData(["packages", "chat-commands", "org_1", null, true], {
    skills: [
      skill("@acme/free", "Free"),
      ...[...stored.pins.map((pin) => pin.id), ...cited]
        .filter((id) => !unlisted.includes(id))
        .map((id) => skill(id, id)),
    ],
    agents: [],
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ChatHostProvider value={host}>
        <ConversationScopeProvider
          value={conversationScope({ originSpaceId: "spc_a", restricted: false })}
        >
          <TooltipProvider>
            <SkillsPickerPanel
              transport={transport}
              skills={stored}
              actions={NO_ACTIONS}
              draft={draftOf(stored, cited)}
            />
          </TooltipProvider>
        </ConversationScopeProvider>
      </ChatHostProvider>
    </QueryClientProvider>,
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
      transport,
      skills: { skillDiscovery, pins: [] },
      actions: { ...NO_ACTIONS, setDiscovery: (on) => emitted.push(on) },
      draft: draftOf({ skillDiscovery, pins: [] }, []),
    });
    const sw = findElement(
      tree,
      (props) => props.id === "skills-discovery" && "onCheckedChange" in props,
    );
    (sw!.props.onCheckedChange as (checked: boolean) => void)(next);
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChatHostProvider value={host}>
        <ConversationScopeProvider
          value={conversationScope({ originSpaceId: "spc_a", restricted: false })}
        >
          <Probe />
        </ConversationScopeProvider>
      </ChatHostProvider>
    </QueryClientProvider>,
  );
  return emitted;
}

describe("SkillsPicker", () => {
  it("hands the new discovery value to the conversation's changes", () => {
    expect(toggleDiscovery(true, false)).toEqual([false]);
    expect(toggleDiscovery(false, true)).toEqual([true]);
  });

  for (const discovery of [true, false]) {
    it(`lists the choosable skills with discovery ${discovery ? "on" : "off"}`, () => {
      const html = render(discovery);
      expect(html).toContain("skill-pin-@acme/free");
      expect(html).toContain("skills.chooseHeading");
      expect(html).not.toContain("skills-mode-");
    });
  }

  it("binds the discovery switch to its label, checked while discovery is on", () => {
    const sw = (html: string) => html.match(/<button[^>]*data-testid="skills-discovery"[^>]*>/)![0];
    expect(sw(render(true))).toContain('aria-checked="true"');
    expect(sw(render(false))).toContain('aria-checked="false"');
    expect(render(true)).toContain('for="skills-discovery"');
    expect(render(true)).toContain("skills.discovery.hintOn");
    expect(render(false)).toContain("skills.discovery.hintOff");
  });

  it("locks an unchosen skill and says why once the chosen skills reach the cap", () => {
    const full = Array.from({ length: MAX_PINNED_SKILLS }, (_, i) => `@acme/own-${i}`);
    const pin = (html: string) =>
      html.match(/<button[^>]*data-testid="skill-pin-@acme\/free"[^>]*>/)![0];
    const atCap = render(true, full);
    expect(atCap).toContain("skills.chosenMax");
    expect(pin(atCap)).toContain(`aria-disabled="true"`);
    const below = render(true, full.slice(1));
    expect(below).not.toContain("skills.chosenMax");
    expect(pin(below)).not.toContain(`aria-disabled="true"`);
  });

  it("shows a cited skill checked and locked, with its hint, even if not pinned", () => {
    const html = render(true, [], ["@acme/cited"]);
    const box = html.match(/<button[^>]*data-testid="skill-pin-@acme\/cited"[^>]*>/)![0];
    expect(box).toContain('aria-checked="true"');
    expect(box).toContain(`aria-disabled="true"`);
    expect(html).toContain("skills.cited");
    // An uncited skill is untouched.
    const free = html.match(/<button[^>]*data-testid="skill-pin-@acme\/free"[^>]*>/)![0];
    expect(free).not.toContain(`aria-disabled="true"`);
  });

  it("counts the cited skills with the pinned ones against the cap", () => {
    const pinned = Array.from({ length: MAX_PINNED_SKILLS - 1 }, (_, i) => `@acme/own-${i}`);
    const html = render(true, pinned, ["@acme/cited"]);
    expect(html).toContain("skills.chosenMax");
    expect(html.match(/<button[^>]*data-testid="skill-pin-@acme\/free"[^>]*>/)![0]).toContain(
      `aria-disabled="true"`,
    );
  });

  /** Toggles each row of `ids` through the rendered tree; returns what the panel handed on (`±id`). */
  function toggleRows(pins: PinnedSkill[], cited: string[], ids: string[]): string[] {
    const toggled: string[] = [];
    // Rows exist only once the catalogue answers: seed it, then toggle through the rendered tree.
    const qc = new QueryClient();
    const skill = (id: string) => ({ id, name: id, description: "", version: null, bytes: null });
    qc.setQueryData(["packages", "chat-commands", "org_1", null, true], {
      skills: ids.map(skill),
      agents: [],
    });
    function Toggle() {
      const tree = SkillsPickerPanel({
        transport,
        skills: { skillDiscovery: true, pins },
        actions: { ...NO_ACTIONS, setPin: (id, on) => toggled.push(`${on ? "+" : "-"}${id}`) },
        draft: draftOf({ skillDiscovery: true, pins }, cited),
      });
      for (const id of ids) {
        const box = findElement(tree, (props) => props["data-testid"] === `skill-pin-${id}`);
        (box!.props.onCheckedChange as () => void)();
      }
      return null;
    }
    renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <ChatHostProvider value={host}>
          <ConversationScopeProvider
            value={conversationScope({ originSpaceId: "spc_a", restricted: false })}
          >
            <Toggle />
          </ConversationScopeProvider>
        </ChatHostProvider>
      </QueryClientProvider>,
    );
    return toggled;
  }

  it("does nothing when a cited skill is toggled: the chip in the message is what drops it", () => {
    expect(toggleRows([userPin("@a/one")], ["@a/one", "@a/two"], ["@a/one", "@a/two"])).toEqual([]);
  });

  it("pins nothing past the cap, and still lets a pin be unchecked there", () => {
    const full = Array.from({ length: MAX_PINNED_SKILLS }, (_, i) => userPin(`@a/own-${i}`));
    expect(toggleRows(full, [], ["@a/extra", "@a/own-0"])).toEqual(["-@a/own-0"]);
    expect(toggleRows([], [], ["@a/extra"])).toEqual(["+@a/extra"]);
  });

  it("names a row's checkbox by its skill alone; the caption and description describe it", () => {
    const html = render(true, [{ id: "@a/big", status: "over_budget", chars: null }]);
    const box = html.match(/<button[^>]*data-testid="skill-pin-@a\/big"[^>]*>/)![0];
    const labelledBy = box.match(/aria-labelledby="([^"]+)"/)![1];
    const describedBy = box.match(/aria-describedby="([^"]+)"/)![1];
    expect(html).toMatch(new RegExp(`id="${labelledBy}"[^>]*>@a/big<`));
    const details = html.slice(html.indexOf(`id="${describedBy}"`));
    expect(details).toContain("skills.state.refused.over_budget");
    // A locked row is not `disabled`: it stays in the tab order, its reason read out.
    expect(render(true, [], ["@a/c"])).not.toMatch(
      /data-testid="skill-pin-@a\/c"[^>]* disabled=""/,
    );
  });

  it("lets every server pin be unchecked, a refused one included", () => {
    const pins: PinnedSkill[] = [
      userPin("@a/mine"),
      { id: "@a/big", status: "over_budget", chars: null },
    ];
    expect(toggleRows(pins, [], ["@a/mine", "@a/big"])).toEqual(["-@a/mine", "-@a/big"]);
  });

  describe("a pinned row is loaded, or not loaded and why", () => {
    const box = (html: string, id: string) =>
      html.match(new RegExp(`<button[^>]*data-testid="skill-pin-${id}"[^>]*>`))![0];
    const caption = (html: string, id: string) =>
      html.match(new RegExp(`data-testid="skill-pin-state-${id}"[^>]*>([^<]*)<`))?.[1];

    it("a loaded pin: checked, enabled, no caption", () => {
      const html = render(true, ["@a/mine"]);
      expect(box(html, "@a/mine")).toContain('aria-checked="true"');
      expect(box(html, "@a/mine")).not.toContain(`aria-disabled="true"`);
      expect(caption(html, "@a/mine")).toBeUndefined();
    });

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
      // A loaded pin the draft cites cannot be unchecked here.
      expect(render(true, ["@a/mine"], ["@a/mine"])).not.toContain("skills-uncheck-hint");
    });

    for (const reason of ["over_budget", "unavailable", "unreadable"] as const) {
      it(`a pin the last turn refused (${reason}): checked, enabled, not loaded and why`, () => {
        const html = render(true, [{ id: "@a/ref", status: reason, chars: null }]);
        expect(box(html, "@a/ref")).toContain('aria-checked="true"');
        expect(box(html, "@a/ref")).not.toContain(`aria-disabled="true"`);
        expect(caption(html, "@a/ref")).toBe(`skills.state.refused.${reason}`);
      });
    }

    it("a cited pin the server refused gives the refusal, not « cited », and stays locked", () => {
      const html = render(true, [{ id: "@a/big", status: "over_budget", chars: 1 }], ["@a/big"]);
      expect(caption(html, "@a/big")).toBe("skills.state.refused.over_budget");
      expect(box(html, "@a/big")).toContain(`aria-disabled="true"`);
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

    it("only the draft locks: a cited row is the one locked", () => {
      const html = render(true, [{ id: "@a/auto", status: "injected", chars: null }], ["@a/cited"]);
      expect(box(html, "@a/cited")).toContain(`aria-disabled="true"`);
      expect(caption(html, "@a/cited")).toBe("skills.cited");
      expect(box(html, "@a/auto")).not.toContain(`aria-disabled="true"`);
    });
  });

  describe("the budget gauge", () => {
    const counts = (html: string) =>
      html.match(/skills\.budget\.counts[^<]*/)?.[0].replace(/&quot;/g, '"');

    it("sums the loaded pins' chars and the listed size of the pending ones", () => {
      const html = render(
        true,
        [
          { id: "@a/loaded", status: "injected", chars: 10_000 },
          { id: "@a/new", status: null, chars: null },
          { id: "@a/big", status: "over_budget", chars: 90_000 },
        ],
        [],
        [],
        { "@a/new": 2_000 },
      );
      expect(counts(html)).toContain('"used":"12,000"');
      expect(counts(html)).toContain('"max":"64,000"');
      expect(html).not.toContain("skills.budget.over");
    });

    it("warns on a row whose size would exceed the budget, still letting it be pinned", () => {
      const html = render(true, [{ id: "@a/loaded", status: "injected", chars: 50_000 }], [], [], {
        "@acme/free": 20_000,
      });
      expect(html).toContain('data-testid="skill-pin-budget-@acme/free"');
      const box = html.match(/<button[^>]*data-testid="skill-pin-@acme\/free"[^>]*>/)![0];
      expect(box).not.toContain(`aria-disabled="true"`);
      const describedBy = box.match(/aria-describedby="([^"]+)"/)![1];
      expect(html.slice(html.indexOf(`id="${describedBy}"`))).toContain(
        "skills.budget.wouldExceed",
      );
      expect(render(true, [], [], [], { "@acme/free": 20_000 })).not.toContain("skill-pin-budget-");
    });

    it("says when the pins already exceed it", () => {
      const html = render(true, [{ id: "@a/new", status: null, chars: null }], [], [], {
        "@a/new": 70_000,
      });
      expect(html).toContain('data-over="true"');
      expect(html).toContain("skills.budget.over");
    });
  });
});
