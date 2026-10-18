// SPDX-License-Identifier: Apache-2.0

/**
 * The picker's trigger takes its tone and count badge from the enforced-skills
 * read: while that read is in flight a skeleton holds the slot, not the button
 * in its default look. SSR only, like `oauth-connect-card-expiry.test.tsx`.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@appstrate/ui/components/tooltip";

import { ChatHostProvider, type ChatHost } from "../src/ui/runtime-context.ts";
import { SkillsPicker } from "../src/ui/skills-picker.tsx";

const host: ChatHost = {
  openFile: () => {},
  downloadFile: () => {},
  useFileImageSrc: () => null,
  t: (key) => key,
  can: () => false,
  personalModelCredentials: true,
  modelCredentials: [],
  formatBytes: String,
};

const getHeaders = () => ({ "X-Space-Id": "spc_1" });

function html(queryClient: QueryClient, headers: typeof getHeaders | undefined): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ChatHostProvider value={host}>
        <TooltipProvider>
          <SkillsPicker
            getHeaders={headers}
            selection={{ skillMode: "manual", pinnedSkills: [] }}
            onChange={() => {}}
          />
        </TooltipProvider>
      </ChatHostProvider>
    </QueryClientProvider>,
  );
}

describe("SkillsPicker trigger", () => {
  it("draws a skeleton, not the button, while the enforced read is in flight", () => {
    const out = html(new QueryClient(), getHeaders);
    expect(out).not.toContain("skills-picker-trigger");
    expect(out).toContain("animate-pulse");
  });

  it("draws the button once the enforced read has answered", () => {
    const qc = new QueryClient();
    qc.setQueryData(["chat", "enforced-skills", "spc_1"], []);
    expect(html(qc, getHeaders)).toContain("skills-picker-trigger");
  });

  it("draws the button when no space is known (the query is disabled, never loading)", () => {
    expect(html(new QueryClient(), undefined)).toContain("skills-picker-trigger");
  });
});
