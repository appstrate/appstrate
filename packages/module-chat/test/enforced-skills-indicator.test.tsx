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
import { ConversationScopeProvider } from "../src/ui/conversation-scope.ts";
import { ChatHostProvider, type ChatHost, type ChatTransport } from "../src/ui/runtime-context.ts";
import { transportOf } from "./fake-request.ts";
import type { SkillHint } from "../src/skills.ts";

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
};

const scoped = transportOf(() => ({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" }));

/** Seeds the shared read, so the render is the answer and not a fetch. */
function render(
  enforced: SkillHint[] | null,
  transport?: ChatTransport | null,
  originSpaceId: string | null = "spc_a",
): string {
  const qc = new QueryClient();
  // `null`: nothing seeded, the read is on its way.
  if (enforced) qc.setQueryData(["chat", "enforced-skills", originSpaceId], enforced);
  return renderToString(
    <QueryClientProvider client={qc}>
      <ChatHostProvider value={host}>
        <ConversationScopeProvider
          value={{ originSpaceId, restricted: false, setRestricted: () => {} }}
        >
          <TooltipProvider>
            <EnforcedSkillsIndicator
              transport={transport === null ? undefined : (transport ?? scoped)}
            />
          </TooltipProvider>
        </ConversationScopeProvider>
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

  it("never waits on a read that does not run: no transport, no placeholder", () => {
    expect(render([], null)).toBe("");
  });

  it("reads nothing in « Vue d'ensemble » or without an origin space: no placeholder, no indicator", () => {
    expect(render(null, undefined, null)).toBe("");
  });

  it("shows none when the author can no longer act in the origin space, as the turn injects none", () => {
    // Seeded for the origin, which is outside the acting set (spc_a only): no skill, no placeholder.
    expect(render([{ packageId: "@a/b", version: "1.0.0" }], undefined, "spc_gone")).toBe("");
  });

  it("keys the read by the conversation's space", () => {
    // Seeded under spc_a, the render under spc_b has no answer yet: it holds its place.
    const qc = new QueryClient();
    qc.setQueryData(["chat", "enforced-skills", "spc_a"], [{ packageId: "@a/b", version: null }]);
    const html = renderToString(
      <QueryClientProvider client={qc}>
        <ChatHostProvider value={{ ...host, actingSpaceIds: ["spc_a", "spc_b"] }}>
          <ConversationScopeProvider
            value={{ originSpaceId: "spc_b", restricted: false, setRestricted: () => {} }}
          >
            <TooltipProvider>
              <EnforcedSkillsIndicator transport={scoped} />
            </TooltipProvider>
          </ConversationScopeProvider>
        </ChatHostProvider>
      </QueryClientProvider>,
    );
    expect(html).toContain("animate-pulse");
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
