// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's read-only indicator, for a member who chats without the skill
 * picker: the names of what the space imposes, and nothing when it imposes
 * nothing.
 */

import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@appstrate/ui/components/tooltip";

import { EnforcedSkillsIndicator } from "../src/ui/enforced-skills.tsx";
import { ChatHostProvider, type ChatHost, type GetHeaders } from "../src/ui/runtime-context.ts";
import type { SkillHint } from "../src/skills.ts";

const host: ChatHost = {
  openFile: () => {},
  downloadFile: () => {},
  useFileImageSrc: () => null,
  t: (key, options) => (options ? `${key} ${JSON.stringify(options)}` : key),
  can: () => true,
  personalModelCredentials: true,
  modelCredentials: [],
  formatBytes: String,
  onPackagesChanged: () => {},
};

const getHeaders = () => ({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" });

/** Seeds the shared read, so the render is the answer and not a fetch. */
function render(enforced: SkillHint[] | null, headers: GetHeaders = getHeaders): string {
  const qc = new QueryClient();
  // `null`: nothing seeded, the read is on its way.
  if (enforced) qc.setQueryData(["chat", "enforced-skills", "spc_a"], enforced);
  return renderToString(
    <QueryClientProvider client={qc}>
      <ChatHostProvider value={host}>
        <TooltipProvider>
          <EnforcedSkillsIndicator getHeaders={headers} />
        </TooltipProvider>
      </ChatHostProvider>
    </QueryClientProvider>,
  );
}

describe("EnforcedSkillsIndicator", () => {
  it("renders nothing when the space imposes nothing", () => {
    expect(render([])).toBe("");
  });

  it("holds its place while the space's read is on its way", () => {
    expect(render(null)).toContain("animate-pulse");
  });

  it("never waits on a read that does not run: no space, no placeholder", () => {
    expect(render([], () => ({ "X-Org-Id": "org_1" }))).toBe("");
  });

  it("names every enforced skill, falling back to the package id", () => {
    const html = render([
      { packageId: "@acme/tone", display_name: "Tone", version: "1.0.0" },
      { packageId: "@acme/policy", version: null },
    ]);
    expect(html).toContain('data-testid="enforced-skills-indicator"');
    expect(html).toContain("Tone, @acme/policy");
    expect(html).toContain("skills.enforcedIndicator");
  });
});
