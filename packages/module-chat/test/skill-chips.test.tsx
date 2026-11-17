// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's skill pill: the user's pins in ONE pill, count or single name, and the picker's
 * chip while none is loaded. SSR only; the tooltip bodies are closed, so the texts are asserted
 * through the accessible names.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@appstrate/ui/components/tooltip";

import { SkillChips } from "../src/ui/skill-chips.tsx";
import { ConversationScopeProvider } from "../src/ui/conversation-scope.ts";
import { ChatHostProvider } from "../src/ui/runtime-context.ts";
import { transportOf } from "./fake-request.ts";
import { conversationScope, testHost } from "./test-host.ts";
import type { ChatSkillSelection } from "../src/skills.ts";

const host = testHost({
  t: (key, options) => (options ? `${key} ${JSON.stringify(options)}` : key),
  actingSpaceIds: ["spc_a"],
});

const scoped = transportOf(() => ({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" }));
const manual = (pinnedSkills: string[]): ChatSkillSelection => ({
  skillMode: "manual",
  pinnedSkills,
});

function render(selection: ChatSkillSelection = manual([])): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChatHostProvider value={host}>
        <ConversationScopeProvider
          value={conversationScope({ originSpaceId: "spc_a", restricted: false })}
        >
          <TooltipProvider>
            <SkillChips transport={scoped} selection={selection} onOpenPicker={() => {}} />
          </TooltipProvider>
        </ConversationScopeProvider>
      </ChatHostProvider>
    </QueryClientProvider>,
  );
}

describe("SkillChips", () => {
  it("draws ONE pill for a single pinned skill, named by its bare package name", () => {
    const html = render(manual(["@acme/policy"]));
    expect(html.match(/skill-pill-pinned/g)).toHaveLength(1);
    expect(html).toContain("policy");
    expect(html).toContain(
      'aria-label="skills.pinnedPillLabel {&quot;skills&quot;:&quot;policy&quot;}"',
    );
  });

  it("counts several pinned skills in the one pill, with no per-skill chip nor « +N »", () => {
    const html = render(manual(["@a/one", "@a/two", "@a/three", "@a/four"]));
    expect(html.match(/skill-pill-pinned/g)).toHaveLength(1);
    expect(html).toContain("skills.pinnedCount {&quot;n&quot;:4}");
    expect(html).toContain(
      "skills.pinnedPillLabel {&quot;skills&quot;:&quot;skills.count {\\&quot;n\\&quot;:4}&quot;}",
    );
  });

  it("ignores pins in automatic mode, where none is injected", () => {
    const html = render({ skillMode: "auto", pinnedSkills: ["@acme/b"] });
    expect(html).toContain('data-testid="skills-picker-trigger"');
    expect(html).not.toContain("skill-pill-pinned");
  });

  it("draws the picker's chip when nothing is loaded off the default selection", () => {
    expect(render()).toContain('data-testid="skills-picker-trigger"');
  });

  it("draws nothing when nothing is loaded on the default selection", () => {
    expect(render({ skillMode: "auto", pinnedSkills: [] })).toBe("");
  });
});
