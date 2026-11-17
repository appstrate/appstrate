// SPDX-License-Identifier: Apache-2.0

/**
 * The skills picker per mode: automatic lists no skill to choose (the assistant picks them itself), manual and
 * strict list the choosable skills. SSR only, the panel rendered without the popover's portal.
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
import type { ChatSkillMode } from "@appstrate/db/schema";

const host = testHost({ actingSpaceIds: ["spc_a"] });

const transport = transportOf(() => ({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" }));

function render(skillMode: ChatSkillMode): string {
  const qc = new QueryClient();
  qc.setQueryData(
    ["packages", "skills", { consumer: "chat" }, ["spc_a"]],
    [{ packageId: "@acme/free", display_name: "Free", version: null }],
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ChatHostProvider value={host}>
        <ConversationScopeProvider
          value={conversationScope({ originSpaceId: "spc_a", restricted: false })}
        >
          <TooltipProvider>
            <SkillsPickerPanel
              transport={transport}
              selection={{ skillMode, pinnedSkills: [] }}
              onChange={() => {}}
            />
          </TooltipProvider>
        </ConversationScopeProvider>
      </ChatHostProvider>
    </QueryClientProvider>,
  );
}

describe("SkillsPicker modes", () => {
  it("lists no choosable skill in automatic mode, with the explanation", () => {
    const html = render("auto");
    expect(html).toContain("skills.chooseInAuto");
    expect(html).not.toContain("skill-pin-");
    expect(html).not.toContain("skills.chooseHeading");
  });

  for (const mode of ["manual", "strict"] as const) {
    it(`still lists the choosable skills in ${mode} mode`, () => {
      const html = render(mode);
      expect(html).toContain("skill-pin-@acme/free");
      expect(html).toContain("skills.chooseHeading");
      expect(html).not.toContain("skills.chooseInAuto");
    });
  }
});
