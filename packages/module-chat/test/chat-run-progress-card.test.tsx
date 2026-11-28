// SPDX-License-Identifier: Apache-2.0

/**
 * The thread's run card: a compact card named and tinted by the agent the `/chat/commands` data
 * knows, a muted veil when it knows none or the launch failed, its integrations drawn by their logo.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IDENTITY_SURFACE_CLASSES } from "@appstrate/ui/identity-colors";
import type { ChatCommands } from "../src/commands.ts";
import { ChatRunProgressCard } from "../src/ui/chat-run-progress-card.tsx";
import { ChatHostProvider } from "../src/ui/runtime-context.ts";
import { testHost } from "./test-host.ts";

const commands: ChatCommands = {
  skills: [],
  agents: [
    {
      name: "agent-amont",
      title: "Agent amont",
      description: "",
      packageId: "@acme/agent-amont",
      icon: null,
      color: "emerald",
      integrations: [{ id: "@acme/slack", name: "Slack", icon: "https://cdn.test/slack.svg" }],
    },
  ],
};

/** A class list as the markup escapes it. */
const inMarkup = (classes: string) => classes.replaceAll(">", "&gt;");

function card(known: boolean, phase: "running" | "error" = "running") {
  const client = new QueryClient();
  if (known) client.setQueryData(["packages", "chat-commands", undefined, null, true], commands);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ChatHostProvider value={testHost()}>
        <ChatRunProgressCard
          runId={undefined}
          agentLabel="@acme/agent-amont"
          initialPackageId="@acme/agent-amont"
          phase={phase}
        />
      </ChatHostProvider>
    </QueryClientProvider>,
  );
}

describe("the thread's run card", () => {
  it("hugs its content, tinted by the agent's colour, its badge on the tile's fill", () => {
    const html = card(true);
    expect(html).toContain("w-fit max-w-full min-w-70");
    expect(html).toContain(inMarkup(IDENTITY_SURFACE_CLASSES.emerald.surface));
    expect(html).toContain(IDENTITY_SURFACE_CLASSES.emerald.badge);
    expect(html).not.toContain("bg-card");
  });

  it("names the agent by its title and draws its integrations' logos", () => {
    const html = card(true);
    expect(html).toContain("Agent amont");
    expect(html).not.toContain("@acme/agent-amont");
    expect(html).toContain('src="https://cdn.test/slack.svg"');
    expect(html).toContain('aria-label="run.integrations"');
  });

  it("falls back to a muted veil and the launch's label for an agent the data does not hold", () => {
    const html = card(false);
    expect(html).toContain(inMarkup(IDENTITY_SURFACE_CLASSES.neutral.surface));
    expect(html).not.toContain("identity-emerald");
    expect(html).toContain("@acme/agent-amont");
  });

  it("drops the tint for a launch that failed before any run existed", () => {
    const html = card(true, "error");
    expect(html).toContain(inMarkup(IDENTITY_SURFACE_CLASSES.neutral.surface));
    expect(html).not.toContain("bg-identity-emerald-tile/50");
    expect(html).toContain("text-destructive animate-in");
  });
});
