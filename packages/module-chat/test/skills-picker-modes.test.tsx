// SPDX-License-Identifier: Apache-2.0

/**
 * The skills picker per mode: automatic lists only what the space imposes (the assistant picks the
 * rest itself), manual and strict add the choosable skills. SSR only, the panel rendered without the popover's portal.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@appstrate/ui/components/tooltip";

import { ChatHostProvider, type ChatHost } from "../src/ui/runtime-context.ts";
import { ConversationScopeProvider } from "../src/ui/conversation-scope.ts";
import { SkillsPickerPanel } from "../src/ui/skills-picker.tsx";
import { transportOf } from "./fake-request.ts";
import type { ChatSkillMode } from "@appstrate/db/schema";

const host: ChatHost = {
  openFile: () => {},
  downloadFile: () => {},
  useFileImageSrc: () => null,
  t: (key) => key,
  can: () => true,
  actingSpaceIds: ["spc_a"],
  personalModelCredentials: true,
  modelCredentials: [],
  formatBytes: String,
};

const transport = transportOf(() => ({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" }));

function render(skillMode: ChatSkillMode): string {
  const qc = new QueryClient();
  qc.setQueryData(
    ["chat", "enforced-skills", "spc_a"],
    [{ packageId: "@acme/tone", display_name: "Tone", version: "1.0.0" }],
  );
  qc.setQueryData(
    ["packages", "skills", { consumer: "chat" }, ["spc_a"]],
    [{ packageId: "@acme/free", display_name: "Free", version: null }],
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ChatHostProvider value={host}>
        <ConversationScopeProvider
          value={{ originSpaceId: "spc_a", restricted: false, setRestricted: () => {} }}
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
  it("lists only the imposed skills in automatic mode, with the explanation", () => {
    const html = render("auto");
    expect(html).toContain("skill-enforced-@acme/tone");
    expect(html).toContain("skills.chooseInAuto");
    expect(html).not.toContain("skill-pin-");
    expect(html).not.toContain("skills.chooseHeading");
  });

  for (const mode of ["manual", "strict"] as const) {
    it(`still lists the choosable skills in ${mode} mode`, () => {
      const html = render(mode);
      expect(html).toContain("skill-enforced-@acme/tone");
      expect(html).toContain("skills.chooseHeading");
      expect(html).not.toContain("skills.chooseInAuto");
    });
  }
});
