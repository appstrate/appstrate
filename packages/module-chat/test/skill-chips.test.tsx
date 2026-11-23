// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's skill pill: the user's pins in ONE pill, count or single name, and the picker's
 * chip while none is pinned. SSR only; the tooltip bodies are closed, so the texts are asserted
 * through the accessible names.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@appstrate/ui/components/tooltip";

import { SkillChips } from "../src/ui/skill-chips.tsx";
import { verdictsSummary } from "../src/ui/skills-summary.ts";
import { ConversationScopeProvider } from "../src/ui/conversation-scope.ts";
import { ChatHostProvider } from "../src/ui/runtime-context.ts";
import { transportOf } from "./fake-request.ts";
import { conversationScope, testHost } from "./test-host.ts";
import type { PinnedSkill } from "../src/skills.ts";
import {
  citedSkillIds,
  effectiveSkills,
  pinIds,
  type StoredSkills,
} from "../src/ui/chat-skills.ts";

const stored = (pins: PinnedSkill[], skillDiscovery = true): StoredSkills => ({
  skillDiscovery,
  pins,
});
const pin = (id: string, status: PinnedSkill["status"] = "injected"): PinnedSkill => ({
  id,
  status,
  chars: null,
});

const host = testHost({
  t: (key, options) => (options ? `${key} ${JSON.stringify(options)}` : key),
  actingSpaceIds: ["spc_a"],
});

const scoped = transportOf(() => ({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" }));
const pinned = (
  ids: string[],
  skillDiscovery = true,
  status: PinnedSkill["status"] = "injected",
): StoredSkills =>
  stored(
    ids.map((id) => pin(id, status)),
    skillDiscovery,
  );

/** A client whose catalogue already answered, naming `@acme/a` « Alpha ». */
function withCatalogue(): QueryClient {
  const qc = new QueryClient();
  qc.setQueryData(["packages", "chat-commands", "org_1", null, true], {
    skills: [{ id: "@acme/a", name: "Alpha", description: "", version: null }],
    agents: [],
  });
  return qc;
}

function render(
  skills: StoredSkills = pinned([], false),
  { client = new QueryClient(), draft = "" }: { client?: QueryClient; draft?: string } = {},
): string {
  const cited = citedSkillIds(draft);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ChatHostProvider value={host}>
        <ConversationScopeProvider
          value={conversationScope({ originSpaceId: "spc_a", restricted: false })}
        >
          <TooltipProvider>
            <SkillChips
              transport={scoped}
              skills={skills}
              draft={{ cited, effective: effectiveSkills(pinIds(skills), cited) }}
              onOpenPicker={() => {}}
              onReset={() => {}}
            />
          </TooltipProvider>
        </ConversationScopeProvider>
      </ChatHostProvider>
    </QueryClientProvider>,
  );
}

describe("SkillChips", () => {
  it("draws ONE pill for a single pinned skill, named by its bare package name", () => {
    const html = render(pinned(["@acme/policy"]));
    expect(html.match(/skill-pill-pinned/g)).toHaveLength(1);
    expect(html).toContain("policy");
    expect(html).toContain(
      'aria-label="skills.pinnedPillLabel {&quot;skills&quot;:&quot;policy&quot;}"',
    );
  });

  it("counts several pinned skills in the one pill, with no per-skill chip nor « +N »", () => {
    const html = render(pinned(["@a/one", "@a/two", "@a/three", "@a/four"]));
    expect(html.match(/skill-pill-pinned/g)).toHaveLength(1);
    expect(html).toContain("skills.pinnedCount {&quot;count&quot;:4}");
    expect(html).toContain(
      "skills.pinnedPillLabel {&quot;skills&quot;:&quot;skills.count {\\&quot;count\\&quot;:4}&quot;}",
    );
  });

  it("draws nothing on the default selection but the empty live region: no pin, discovery on", () => {
    expect(render(pinned([]))).toBe(
      '<span aria-live="polite" data-testid="skill-pill-live" class="sr-only"></span>',
    );
  });

  describe("the live region", () => {
    const live = (html: string) => html.match(/data-testid="skill-pill-live"[^>]*>([^<]*)</)![1];
    const names = new Map([["@acme/a", "Alpha"]]);
    const verdicts = stored([pin("@acme/a"), pin("@acme/b"), pin("@acme/big", "over_budget")]);

    it("is one polite region, silent on the verdicts the conversation opens on", () => {
      const html = render(verdicts, { client: withCatalogue() });
      expect(html.match(/aria-live=/g)).toHaveLength(1);
      expect(live(html)).toBe("");
    });

    it("summarises the last turn's verdicts, joined through i18n", () => {
      expect(verdictsSummary(verdicts, names, host.t)).toBe(
        'skills.liveSummary {"loaded":"skills.count {\\"count\\":2}","refused":"skills.notLoadedCount {\\"count\\":1}"}',
      );
    });

    it("has nothing to say until the catalogue names the skills, so a name swap is never read out", () => {
      expect(verdictsSummary(verdicts, null, host.t)).toBeNull();
      const single = stored([pin("@acme/a")]);
      expect(verdictsSummary(single, names, host.t)).toBe("Alpha");
    });

    it("reads out verdicts only, never a pin no turn judged yet", () => {
      const before = verdictsSummary(verdicts, names, host.t);
      const added = stored([...verdicts.pins, pin("@acme/new", null)]);
      expect(verdictsSummary(added, names, host.t)).toBe(before);
      expect(verdictsSummary(stored([pin("@acme/a", null)]), names, host.t)).toBe("");
    });
  });

  it("draws the pill for pins with discovery on, with a book and the locked label off", () => {
    expect(render(pinned(["@acme/b"]))).not.toContain("pinnedLockedPillLabel");
    const off = render(pinned(["@acme/b"], false));
    expect(off).toContain("skills.pinnedLockedPillLabel");
    expect(off.match(/skill-pill-pinned/g)).toHaveLength(1);
  });

  it("draws the picker's chip when nothing is pinned and discovery is off", () => {
    const html = render(pinned([], false));
    expect(html).toContain('data-testid="skills-discovery-off-chip"');
    expect(html).toContain("skills.discoveryOffChip");
    expect(html).toContain('aria-label="skills.reset"');
  });

  it("never counts a pin the last turn refused as loaded", () => {
    const html = render(stored([pin("@a/one"), pin("@a/big", "over_budget")]));
    expect(html.match(/skill-pill-pinned/g)).toHaveLength(1);
    expect(html).toContain(
      'aria-label="skills.pinnedPillLabel {&quot;skills&quot;:&quot;one&quot;}"',
    );
    // Only refused pins: the pill stays, counting what is not loaded, with the reset.
    const refusedOnly = render(pinned(["@a/big", "@a/gone"], true, "unavailable"));
    expect(refusedOnly.match(/skill-pill-pinned/g)).toHaveLength(1);
    expect(refusedOnly).toContain("skills.notLoadedCount {&quot;count&quot;:2}");
    expect(refusedOnly).toContain('aria-label="skills.reset"');
  });

  it("counts a pin no turn judged yet and a skill the draft cites: the next turn loads them", () => {
    const draft = ":skill[two]{name=@a/two}";
    expect(render(stored([pin("@a/one", null)]), { draft })).toContain(
      "skills.pinnedCount {&quot;count&quot;:2}",
    );
  });

  it("puts an X restoring the default on the pinned pill", () => {
    const html = render(pinned(["@acme/b"]));
    expect(html).toContain('data-testid="skill-pill-pinned"');
    expect(html).toContain('aria-label="skills.reset"');
  });
});
