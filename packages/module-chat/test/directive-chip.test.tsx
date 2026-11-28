// SPDX-License-Identifier: Apache-2.0

/**
 * The directive chip's pieces: the composer draws a skill or an agent as a chip and any other type
 * as its text, and an agent's glyph is the tile of the commands entry its prompt name finds, the
 * bot icon otherwise.
 */

import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { ChatCommands } from "../src/commands.ts";
import { AgentGlyph } from "../src/ui/agent-glyph.tsx";
import { ComposerDirectiveChip, DirectiveText } from "../src/ui/directive-chip.tsx";
import { ChatHostProvider } from "../src/ui/runtime-context.ts";
import { testHost } from "./test-host.ts";

const commands: ChatCommands = {
  skills: [],
  agents: [
    {
      name: "run-report",
      title: "Weekly report",
      description: "",
      packageId: "@acme/report",
      icon: "lucide:chart-bar",
      color: "blue",
      integrations: [],
    },
  ],
};

describe("the composer's chip", () => {
  const draw = (directiveType: string, directiveId: string, label: string) =>
    renderToString(
      <ComposerDirectiveChip
        directiveType={directiveType}
        directiveId={directiveId}
        label={label}
      />,
    );

  it("draws a skill as a chip with no remove button", () => {
    const html = draw("skill", "@acme/tone", "tone");
    expect(html).toContain('data-testid="directive-chip"');
    expect(html).not.toContain("<button");
  });

  it("draws an unknown directive type as the text it was, not as a skill's chip", () => {
    const html = draw("note", "x", "remember");
    expect(html).not.toContain("directive-chip");
    expect(html).not.toContain("lucide-book-open");
    expect(html).toContain(":note[remember]{name=x}");
  });
});

describe("an agent's glyph", () => {
  it("is the bot icon without an entry, the tile with one", () => {
    const bot = renderToString(<AgentGlyph agent={undefined} label="Weekly report" />);
    expect(bot).toContain("lucide-bot");
    expect(bot).not.toContain("data-slot");
    const tile = renderToString(<AgentGlyph agent={commands.agents[0]} label="Weekly report" />);
    expect(tile).not.toContain("lucide-bot");
    expect(tile).toContain("size-4");
  });

  it("is drawn by a sent chip from the cached commands, the bot icon when they are not loaded", () => {
    const text = ":agent[Weekly report]{name=run-report}";
    const page = (client: QueryClient) =>
      renderToString(
        <QueryClientProvider client={client}>
          <ChatHostProvider value={testHost()}>
            <DirectiveText text={text} />
          </ChatHostProvider>
        </QueryClientProvider>,
      );
    expect(page(new QueryClient())).toContain("lucide-bot");
    const loaded = new QueryClient();
    loaded.setQueryData(["packages", "chat-commands", undefined, null, true], commands);
    expect(page(loaded)).not.toContain("lucide-bot");
  });
});
