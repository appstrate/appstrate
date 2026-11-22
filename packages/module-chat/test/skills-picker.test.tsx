// SPDX-License-Identifier: Apache-2.0

/**
 * The skills picker: the choosable skills are listed whether discovery is on or off, and the
 * discovery switch reflects the selection. SSR only, the panel rendered without the popover's portal.
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
import { MAX_PINNED_SKILLS, type ChatSkillSelection } from "../src/skills.ts";

const host = testHost({ actingSpaceIds: ["spc_a"] });

const transport = transportOf(() => ({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" }));

function render(skillDiscovery: boolean, pinnedSkills: string[] = []): string {
  const qc = new QueryClient();
  const skill = (id: string, name: string) => ({ id, name, description: "", version: null });
  qc.setQueryData(["packages", "chat-commands", "org_1", null], {
    skills: [skill("@acme/free", "Free"), ...pinnedSkills.map((id) => skill(id, id))],
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
              selection={{ skillDiscovery, pinnedSkills }}
              onChange={() => {}}
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
function toggleDiscovery(selection: ChatSkillSelection, next: boolean): ChatSkillSelection[] {
  const emitted: ChatSkillSelection[] = [];
  function Probe() {
    const tree = SkillsPickerPanel({
      transport,
      selection,
      onChange: (s) => emitted.push(s),
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
  it("emits the selection with the new discovery value, pins kept", () => {
    expect(toggleDiscovery({ skillDiscovery: true, pinnedSkills: ["@a/one"] }, false)).toEqual([
      { skillDiscovery: false, pinnedSkills: ["@a/one"] },
    ]);
    expect(toggleDiscovery({ skillDiscovery: false, pinnedSkills: [] }, true)).toEqual([
      { skillDiscovery: true, pinnedSkills: [] },
    ]);
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

  it("disables an unchosen skill and says why once the chosen skills reach the cap", () => {
    const full = Array.from({ length: MAX_PINNED_SKILLS }, (_, i) => `@acme/own-${i}`);
    const pin = (html: string) =>
      html.match(/<button[^>]*data-testid="skill-pin-@acme\/free"[^>]*>/)![0];
    const atCap = render(true, full);
    expect(atCap).toContain("skills.chosenMax");
    expect(pin(atCap)).toContain(` disabled=""`);
    const below = render(true, full.slice(1));
    expect(below).not.toContain("skills.chosenMax");
    expect(pin(below)).not.toContain(` disabled=""`);
  });
});
