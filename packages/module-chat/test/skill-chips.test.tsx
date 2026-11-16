// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's skill pills: what the conversation loads (the origin space's imposed skills in
 * ONE locked pill, the user's pins in ONE other), count or single name, the skeleton while the enforced
 * read is on its way. SSR only; the tooltip bodies are closed, so the texts are asserted through
 * the accessible names.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@appstrate/ui/components/tooltip";

import { SkillChips } from "../src/ui/enforced-skills.tsx";
import { ConversationScopeProvider } from "../src/ui/conversation-scope.ts";
import { ChatHostProvider, type ChatTransport } from "../src/ui/runtime-context.ts";
import { testHost, transportOf } from "./fake-request.ts";
import type { ChatSkillSelection, SkillHint } from "../src/skills.ts";

const host = testHost({
  t: (key, options) => (options ? `${key} ${JSON.stringify(options)}` : key),
  actingSpaceIds: ["spc_a"],
  useSpaceLabelOf: () => (id) => (id === "spc_a" ? "Studio" : undefined),
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
  originSpaceId?: string | null;
  picker?: boolean;
  canReadSkills?: boolean;
}

function render({
  enforced = [],
  selection = manual([]),
  transport = scoped,
  originSpaceId = "spc_a",
  picker = true,
  canReadSkills = true,
}: Options = {}): string {
  const qc = new QueryClient();
  // `null`: nothing seeded, the read is on its way.
  if (enforced) qc.setQueryData(["chat", "enforced-skills", originSpaceId], enforced);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ChatHostProvider value={{ ...host, can: () => canReadSkills }}>
        <ConversationScopeProvider
          value={{ originSpaceId, restricted: false, generating: false, setRestricted: () => {} }}
        >
          <TooltipProvider>
            <SkillChips
              transport={transport === null ? undefined : transport}
              selection={selection}
              onOpenPicker={picker ? () => {} : undefined}
              fallback={<i data-testid="fallback" />}
            />
          </TooltipProvider>
        </ConversationScopeProvider>
      </ChatHostProvider>
    </QueryClientProvider>,
  );
}

const tone: SkillHint = { packageId: "@acme/tone", display_name: "Tone", version: "1.0.0" };

const policy: SkillHint = { packageId: "@acme/policy", display_name: "Policy", version: null };

describe("SkillChips", () => {
  it("draws ONE locked pill for a single imposed skill, named, with the space in its label", () => {
    const html = render({ enforced: [tone] });
    expect(html.match(/skill-pill-enforced/g)).toHaveLength(1);
    expect(html).toContain("Tone");
    expect(html).toContain("skills.enforcedPillLabel");
    expect(html).toContain("Studio");
    expect(html).not.toContain("skills.enforcedCount");
  });

  it("counts several imposed skills in the one pill, naming them in its accessible label", () => {
    const html = render({ enforced: [tone, policy] });
    expect(html.match(/skill-pill-enforced/g)).toHaveLength(1);
    expect(html).toContain("skills.enforcedCount {&quot;n&quot;:2}");
    // The tooltip's list is closed: the names reach the label.
    expect(html).toContain("Tone, Policy");
  });

  it("shows imposed skills read-only, without the picker: a focusable note, no pins, no « + »", () => {
    const html = render({
      enforced: [tone],
      selection: manual(["@acme/pinned"]),
      picker: false,
      canReadSkills: false,
    });
    expect(html).toContain("skill-pill-enforced");
    expect(html).toContain('role="note"');
    expect(html).toContain('tabindex="0"');
    expect(html).not.toContain("skill-pill-pinned");
    expect(html).not.toContain("skill-chips-add");
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
    expect(html).toContain("skills.pinnedPillLabel");
    expect(html).toContain('data-testid="skill-chips-add"');
    expect(html).not.toContain("skill-chip-remove");
  });

  it("counts several pinned skills in the one pill, with no per-skill chip nor « +N »", () => {
    const html = render({ selection: manual(["@a/one", "@a/two", "@a/three", "@a/four"]) });
    expect(html.match(/skill-pill-pinned/g)).toHaveLength(1);
    expect(html).toContain("skills.pinnedCount {&quot;n&quot;:4}");
    expect(html).toContain("one, two, three, four");
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
    expect(html).toContain('data-testid="fallback"');
    expect(html).not.toContain("skill-pill-pinned");
  });

  it("falls back to the picker entry when nothing is loaded", () => {
    expect(render()).toContain('data-testid="fallback"');
  });

  it("shows no imposed skill in « Vue d'ensemble »: no read, no pill, no placeholder", () => {
    const html = render({ enforced: null, originSpaceId: null });
    expect(html).toContain('data-testid="fallback"');
    expect(html).not.toContain("animate-pulse");
  });

  it("shows none when the author can no longer act in the origin space", () => {
    const html = render({ enforced: [tone], originSpaceId: "spc_gone" });
    expect(html).not.toContain("skill-pill-enforced");
  });

  it("holds the place with a skeleton while the imposed skills load", () => {
    const html = render({ enforced: null });
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("skill-pill");
    expect(html).not.toContain('data-testid="fallback"');
  });
});
