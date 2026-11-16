// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's skill chips: what the conversation loads (the origin space's imposed skills,
 * locked, and the user's pins, removable), the « +N » overflow, the skeleton while the enforced
 * read is on its way. SSR only; the tooltip bodies are closed, so the texts are asserted through
 * the accessible names.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@appstrate/ui/components/tooltip";

import { SkillChips } from "../src/ui/enforced-skills.tsx";
import { splitSkillChips, type SkillChipModel } from "../src/ui/chat-skills.ts";
import { ConversationScopeProvider } from "../src/ui/conversation-scope.ts";
import { ChatHostProvider, type ChatHost, type ChatTransport } from "../src/ui/runtime-context.ts";
import { transportOf } from "./fake-request.ts";
import type { ChatSkillSelection, SkillHint } from "../src/skills.ts";

const host: ChatHost = {
  openFile: () => {},
  downloadFile: () => {},
  useFileImageSrc: () => null,
  t: (key, options) => (options ? `${key} ${JSON.stringify(options)}` : key),
  can: () => true,
  actingSpaceIds: ["spc_a"],
  personalModelCredentials: true,
  modelCredentials: [],
  formatBytes: String,
  onPackagesChanged: () => {},
  useSpaceLabelOf: () => (id) => (id === "spc_a" ? "Studio" : undefined),
};

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
          value={{ originSpaceId, restricted: false, setRestricted: () => {} }}
        >
          <TooltipProvider>
            <SkillChips
              transport={transport === null ? undefined : transport}
              selection={selection}
              onSelectionChange={() => {}}
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

describe("SkillChips", () => {
  it("draws an imposed skill locked, named, with the space in its accessible name", () => {
    const html = render({ enforced: [tone] });
    expect(html).toContain('data-testid="skill-chip-enforced"');
    expect(html).toContain("Tone");
    expect(html).toContain("skills.chipEnforcedLabel");
    expect(html).toContain("Studio");
    expect(html).not.toContain("skill-chip-remove");
  });

  it("shows imposed skills read-only, without the picker: no pins, no « + »", () => {
    const html = render({
      enforced: [tone],
      selection: manual(["@acme/pinned"]),
      picker: false,
      canReadSkills: false,
    });
    expect(html).toContain("skill-chip-enforced");
    expect(html).toContain('role="note"');
    expect(html).not.toContain("skill-chip-pinned");
    expect(html).not.toContain("skill-chips-add");
  });

  it("draws a pinned skill removable, named by its bare package name", () => {
    const html = render({ selection: manual(["@acme/policy"]) });
    expect(html).toContain('data-testid="skill-chip-pinned"');
    expect(html).toContain("policy");
    expect(html).toContain("skills.chipRemove");
    expect(html).toContain('data-testid="skill-chips-add"');
  });

  it("lists the imposed skills before the pins, and never twice", () => {
    const html = render({ enforced: [tone], selection: manual(["@acme/tone", "@acme/b"]) });
    expect(html.match(/skill-chip-enforced/g)).toHaveLength(1);
    expect(html.match(/skill-chip-pinned/g)).toHaveLength(1);
    expect(html.indexOf("skill-chip-enforced")).toBeLessThan(html.indexOf("skill-chip-pinned"));
  });

  it("ignores pins in automatic mode, where none is injected", () => {
    const html = render({ selection: { skillMode: "auto", pinnedSkills: ["@acme/b"] } });
    expect(html).toContain('data-testid="fallback"');
    expect(html).not.toContain("skill-chip-pinned");
  });

  it("folds the rest into a « +N » chip past the visible ones", () => {
    const html = render({ selection: manual(["@a/one", "@a/two", "@a/three", "@a/four"]) });
    expect(html.match(/skill-chip-pinned/g)).toHaveLength(2);
    expect(html).toContain('data-testid="skill-chip-overflow"');
    expect(html).toContain("skills.chipsMore");
    expect(html).toContain("three, four");
  });

  it("falls back to the picker entry when nothing is loaded", () => {
    expect(render()).toContain('data-testid="fallback"');
  });

  it("shows no imposed skill in « Vue d'ensemble »: no read, no chip, no placeholder", () => {
    const html = render({ enforced: null, originSpaceId: null });
    expect(html).toContain('data-testid="fallback"');
    expect(html).not.toContain("animate-pulse");
  });

  it("shows none when the author can no longer act in the origin space", () => {
    const html = render({ enforced: [tone], originSpaceId: "spc_gone" });
    expect(html).not.toContain("skill-chip-enforced");
  });

  it("holds the place with a skeleton while the imposed skills load", () => {
    const html = render({ enforced: null });
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("skill-chip");
    expect(html).not.toContain('data-testid="fallback"');
  });
});

describe("splitSkillChips", () => {
  const chip = (i: number): SkillChipModel => ({
    packageId: `@a/${i}`,
    name: `${i}`,
    enforced: false,
  });
  it("shows everything up to the limit", () => {
    expect(splitSkillChips([chip(1), chip(2)]).overflow).toHaveLength(0);
  });
  it("does not fold a single chip into « +1 »", () => {
    expect(splitSkillChips([chip(1), chip(2), chip(3)]).overflow).toHaveLength(0);
  });
  it("folds two or more", () => {
    const { visible, overflow } = splitSkillChips([chip(1), chip(2), chip(3), chip(4)]);
    expect([visible.length, overflow.length]).toEqual([2, 2]);
  });
});
