// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's skill pills: what the conversation loads (the space's imposed skills in
 * ONE locked pill, the user's pins in ONE other), count or single name, the picker's chip while none
 * is, and a skeleton while the enforced read is on its way only where something is sure to be drawn.
 * SSR only; the tooltip bodies are closed, so the texts are asserted through the accessible names.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@appstrate/ui/components/tooltip";

import { SkillChips } from "../src/ui/skill-chips.tsx";
import { ChatHostProvider, type ChatTransport } from "../src/ui/runtime-context.ts";
import { transportOf } from "./fake-request.ts";
import { testHost } from "./test-host.ts";
import type { ChatSkillSelection, SkillHint } from "../src/skills.ts";

const host = testHost({
  t: (key, options) => (options ? `${key} ${JSON.stringify(options)}` : key),
});

const scoped = transportOf(() => ({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" }));
const manual = (pinnedSkills: string[]): ChatSkillSelection => ({
  skillMode: "manual",
  pinnedSkills,
});

interface Options {
  enforced?: SkillHint[] | null;
  selection?: ChatSkillSelection;
  transport?: ChatTransport | null;
  picker?: boolean;
  canReadSkills?: boolean;
}

function render({
  enforced = [],
  selection = manual([]),
  transport = scoped,
  picker = true,
  canReadSkills = true,
}: Options = {}): string {
  const qc = new QueryClient();
  // `null`: nothing seeded, the read is on its way.
  if (enforced) qc.setQueryData(["chat", "enforced-skills", "spc_a"], enforced);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ChatHostProvider value={{ ...host, can: () => canReadSkills }}>
        <TooltipProvider>
          <SkillChips
            transport={transport === null ? undefined : transport}
            selection={selection}
            onOpenPicker={picker ? () => {} : undefined}
          />
        </TooltipProvider>
      </ChatHostProvider>
    </QueryClientProvider>,
  );
}

const tone: SkillHint = { packageId: "@acme/tone", display_name: "Tone", version: "1.0.0" };

const policy: SkillHint = { packageId: "@acme/policy", display_name: "Policy", version: null };

describe("SkillChips", () => {
  it("draws ONE locked pill for a single imposed skill, named, with the policy and action in its label", () => {
    const html = render({ enforced: [tone] });
    expect(html.match(/skill-pill-enforced/g)).toHaveLength(1);
    expect(html).toContain(
      'aria-label="skills.enforcedPillAction {&quot;skills&quot;:&quot;Tone&quot;}"',
    );
    expect(html).not.toContain("skills.enforcedCount");
  });

  it("counts several imposed skills in the one pill: the label says how many, the tooltip lists them", () => {
    const html = render({ enforced: [tone, policy] });
    expect(html.match(/skill-pill-enforced/g)).toHaveLength(1);
    expect(html).toContain("skills.enforcedCount {&quot;n&quot;:2}");
    expect(html).toContain("skills.count {\\&quot;n\\&quot;:2}");
    // The names are the tooltip's, announced once: never in the label too.
    expect(html).not.toContain("Tone, Policy");
  });

  it("shows imposed skills read-only, without the picker: a focusable note, no pins, no chip", () => {
    const html = render({
      enforced: [tone],
      selection: manual(["@acme/pinned"]),
      picker: false,
      canReadSkills: false,
    });
    expect(html).toContain("skill-pill-enforced");
    expect(html).toContain('role="note"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("skills.enforcedPillLabel");
    expect(html).not.toContain("skills.enforcedPillAction");
    expect(html).not.toContain("skill-pill-pinned");
    expect(html).not.toContain("skills-picker-trigger");
  });

  it("opens the picker from the imposed pill when the user can pick", () => {
    const html = render({ enforced: [tone] });
    expect(html).toMatch(/<button[^>]*data-testid="skill-pill-enforced"/);
    expect(html).not.toContain('role="note"');
  });

  it("draws ONE pill for a single pinned skill, named by its bare package name", () => {
    const html = render({ selection: manual(["@acme/policy"]) });
    expect(html.match(/skill-pill-pinned/g)).toHaveLength(1);
    expect(html).toContain("policy");
    expect(html).toContain(
      'aria-label="skills.pinnedPillLabel {&quot;skills&quot;:&quot;policy&quot;}"',
    );
    expect(html).not.toContain("skill-chip-remove");
  });

  it("counts several pinned skills in the one pill, with no per-skill chip nor « +N »", () => {
    const html = render({ selection: manual(["@a/one", "@a/two", "@a/three", "@a/four"]) });
    expect(html.match(/skill-pill-pinned/g)).toHaveLength(1);
    expect(html).toContain("skills.pinnedCount {&quot;n&quot;:4}");
    expect(html).toContain(
      "skills.pinnedPillLabel {&quot;skills&quot;:&quot;skills.count {\\&quot;n\\&quot;:4}&quot;}",
    );
    expect(html).not.toContain("skill-chip-overflow");
  });

  it("lists the imposed pill before the pinned one, and never counts a skill twice", () => {
    const html = render({ enforced: [tone], selection: manual(["@acme/tone", "@acme/b"]) });
    expect(html.match(/skill-pill-enforced/g)).toHaveLength(1);
    expect(html.match(/skill-pill-pinned/g)).toHaveLength(1);
    expect(html.indexOf("skill-pill-enforced")).toBeLessThan(html.indexOf("skill-pill-pinned"));
    // One own pin left once the imposed one is taken out: its name, not a count.
    expect(html).not.toContain("skills.pinnedCount");
  });

  it("ignores pins in automatic mode, where none is injected", () => {
    const html = render({ selection: { skillMode: "auto", pinnedSkills: ["@acme/b"] } });
    expect(html).toContain('data-testid="skills-picker-trigger"');
    expect(html).not.toContain("skill-pill-pinned");
  });

  it("draws the picker's chip when nothing is loaded off the default selection", () => {
    expect(render()).toContain('data-testid="skills-picker-trigger"');
  });

  it("draws nothing when nothing is loaded on the default selection", () => {
    expect(render({ selection: { skillMode: "auto", pinnedSkills: [] } })).toBe("");
  });

  it("shows no imposed skill without a space: no read, no pill, no placeholder", () => {
    const html = render({
      enforced: null,
      transport: transportOf(() => ({ "X-Org-Id": "org_1" })),
    });
    expect(html).toContain('data-testid="skills-picker-trigger"');
    expect(html).not.toContain("animate-pulse");
  });

  it("holds the place with a skeleton while the imposed skills load, off the default selection", () => {
    const html = render({ enforced: null });
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("skill-pill");
    expect(html).not.toContain("skills-picker-trigger");
  });

  it("holds the place with a skeleton while the imposed skills load, without the picker", () => {
    const html = render({ enforced: null, picker: false, canReadSkills: false });
    expect(html).toContain("animate-pulse");
  });

  it("draws no skeleton while loading on the default selection: nothing is sure to follow", () => {
    expect(render({ enforced: null, selection: { skillMode: "auto", pinnedSkills: [] } })).toBe("");
  });
});
