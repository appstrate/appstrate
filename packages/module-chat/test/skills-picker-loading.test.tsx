// SPDX-License-Identifier: Apache-2.0

/**
 * The skills chip takes its count from the enforced-skills
 * read: while that read is in flight a skeleton holds the slot, not the button
 * in its default look. SSR only, like `oauth-connect-card-expiry.test.tsx`.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@appstrate/ui/components/tooltip";

import { ChatHostProvider, type ChatHost } from "../src/ui/runtime-context.ts";
import { ConversationScopeProvider } from "../src/ui/conversation-scope.ts";
import { SkillsChip } from "../src/ui/skills-picker.tsx";
import { transportOf } from "./fake-request.ts";

const host: ChatHost = {
  openFile: () => {},
  downloadFile: () => {},
  useFileImageSrc: () => null,
  t: (key) => key,
  can: () => false,
  actingSpaceIds: [],
  personalModelCredentials: true,
  modelCredentials: [],
  formatBytes: String,
};

const scoped = transportOf(() => ({ "X-Space-Id": "spc_1" }));

function html(queryClient: QueryClient, transport: typeof scoped | undefined): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ChatHostProvider value={host}>
        <ConversationScopeProvider
          value={{ originSpaceId: "spc_1", restricted: false, setRestricted: () => {} }}
        >
          <TooltipProvider>
            <SkillsChip
              transport={transport}
              selection={{ skillMode: "manual", pinnedSkills: [] }}
              onClick={() => {}}
            />
          </TooltipProvider>
        </ConversationScopeProvider>
      </ChatHostProvider>
    </QueryClientProvider>,
  );
}

describe("SkillsChip", () => {
  it("draws a skeleton, not the button, while the enforced read is in flight", () => {
    const out = html(new QueryClient(), scoped);
    expect(out).not.toContain("skills-picker-trigger");
    expect(out).toContain("animate-pulse");
  });

  it("draws the button once the enforced read has answered", () => {
    const qc = new QueryClient();
    qc.setQueryData(["chat", "enforced-skills", "spc_1"], []);
    expect(html(qc, scoped)).toContain("skills-picker-trigger");
  });

  it("draws the button when no transport is known (the query is disabled, never loading)", () => {
    expect(html(new QueryClient(), undefined)).toContain("skills-picker-trigger");
  });
});
