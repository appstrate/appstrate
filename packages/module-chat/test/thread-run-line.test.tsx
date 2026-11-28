// SPDX-License-Identifier: Apache-2.0

/**
 * A run in the thread: one activity line, no box, led by the agent's 16px tile, its name a button
 * opening the run in the context panel; what a short state cannot say goes under the line, in full.
 */

import { describe, expect, it } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@appstrate/ui/components/tooltip";
import type { ChatCommands } from "../src/commands.ts";
import { ThreadRunLine } from "../src/ui/thread-run-line.tsx";
import { stateTextClass } from "../src/ui/run-events.ts";
import { ChatHostProvider, type ChatHost, type ThreadItem } from "../src/ui/runtime-context.ts";
import { testHost } from "./test-host.ts";

const commands: ChatCommands = {
  skills: [],
  agents: [
    {
      name: "agent-amont",
      title: "Agent amont",
      description: "",
      packageId: "@acme/agent-amont",
      spaceId: "spc_a",
      icon: null,
      color: "emerald",
      integrations: [{ id: "@acme/slack", name: "Slack", icon: "https://cdn.test/slack.svg" }],
    },
    // The same agent installed in another space, with another integration.
    {
      name: "run-b-agent-amont",
      title: "Agent amont",
      description: "",
      packageId: "@acme/agent-amont",
      spaceId: "spc_b",
      icon: null,
      color: "emerald",
      integrations: [{ id: "@acme/gmail", name: "Gmail", icon: "https://cdn.test/gmail.svg" }],
    },
  ],
};

type LineProps = React.ComponentProps<typeof ThreadRunLine>;

function render(
  props: Partial<LineProps> = {},
  { known = true, host = {} }: { known?: boolean; host?: Partial<ChatHost> } = {},
) {
  const client = new QueryClient();
  if (known) client.setQueryData(["packages", "chat-commands", undefined, null, true], commands);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ChatHostProvider value={testHost(host)}>
        <TooltipProvider>
          <ThreadRunLine
            runId={undefined}
            agentLabel="@acme/agent-amont"
            initialPackageId="@acme/agent-amont"
            phase="running"
            {...props}
          />
        </TooltipProvider>
      </ChatHostProvider>
    </QueryClientProvider>,
  );
}

/** The markup past the image preloads React hoists before the root. */
const rooted = (html: string) => html.replace(/^(<link [^>]*\/>)+/, "");

/** The root element's class list. */
function rootClass(html: string): string {
  const match = /^<div[^>]*class="([^"]*)"/.exec(rooted(html));
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

/** The first element under `node`, through every prop, that has an `onClick`. */
function clickable(node: ReactNode): ReactElement<{ onClick: () => void }> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = clickable(child as ReactNode);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if (typeof node.props.onClick === "function") {
    return node as ReactElement<{ onClick: () => void }>;
  }
  for (const value of Object.values(node.props)) {
    const hit = clickable(value as ReactNode);
    if (hit) return hit;
  }
  return undefined;
}

describe("a run's line in the thread", () => {
  it("keeps a log line's monospace and its enter animation as separate classes", () => {
    const html = renderToStaticMarkup(<span className={stateTextClass(true)} />);
    expect(html).toContain("font-mono animate-in");
    expect(html).not.toContain("font-monoanimate-in");
    expect(stateTextClass(false)).toStartWith("animate-in");
  });

  it("is a line with no border, background or card padding", () => {
    const root = rootClass(render());
    expect(root).not.toMatch(/(^|\s)border(\s|$|-)/);
    expect(root).not.toMatch(/(^|\s)bg-/);
    expect(root).not.toMatch(/(^|\s)(p|px|py)-/);
    expect(render()).toContain("desktop-pointer:h-8 flex h-10");
  });

  it("names the agent by its title and draws its integrations' logos", () => {
    const html = render({ runId: "run_1", initialStatus: "running", spaceId: "spc_a" });
    expect(html).toContain(">Agent amont<");
    expect(html).not.toContain(">@acme/agent-amont<");
    expect(html).toContain('src="https://cdn.test/slack.svg"');
    expect(html).toContain('data-testid="integration-logo-stack"');
    expect(html).toContain('aria-label="Integrations: Slack"');
  });

  it("draws the install of the run's space, not the agent's first entry", () => {
    const html = render({ runId: "run_1", initialStatus: "running", spaceId: "spc_b" });
    expect(html).toContain('src="https://cdn.test/gmail.svg"');
    expect(html).not.toContain("slack.svg");
    // A space the agent is not offered in holds no install: the neutral tile, no logos.
    const elsewhere = render({ runId: "run_1", initialStatus: "running", spaceId: "spc_c" });
    expect(elsewhere).toContain("bg-muted text-muted-foreground flex size-4");
    expect(elsewhere).not.toContain('data-testid="integration-logo-stack"');
  });

  it("draws no integrations without the run's space: the first entry's may be another install", () => {
    const html = render({ runId: "run_1", initialStatus: "running" });
    expect(html).toContain(">Agent amont<");
    expect(html).not.toContain('data-testid="integration-logo-stack"');
  });

  it("leads with the agent's 16px tile, a neutral bot tile for an agent the data does not hold", () => {
    expect(render()).toContain("size-4 shrink-0 rounded-sm");
    const unknown = render({}, { known: false });
    expect(unknown).toContain("bg-muted text-muted-foreground flex size-4");
    expect(unknown).toContain("@acme/agent-amont");
  });

  it("makes the name the button, opening the run in the host's panel", () => {
    const html = render({ runId: "run_1", initialStatus: "running" });
    // The button holds the name and nothing else: its accessible name is the agent's.
    expect(html).toMatch(
      /<button[^>]*><span class="[^"]*shimmer-text[^"]*">Agent amont<\/span><\/button>/,
    );

    const opened: ThreadItem[] = [];
    function Probe() {
      clickable(
        ThreadRunLine({
          runId: "run_1",
          initialStatus: "success",
          agentLabel: "@acme/agent-amont",
          phase: "success",
        }),
      )?.props.onClick();
      return null;
    }
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ChatHostProvider value={testHost({ openThreadItem: (item) => opened.push(item) })}>
          <Probe />
        </ChatHostProvider>
      </QueryClientProvider>,
    );
    expect(opened).toEqual([{ kind: "run", id: "run_1" }]);
  });

  it("is no button without a run id, its launch failure's message under the line in full", () => {
    const message = "Agent introuvable dans cet espace : vérifiez son identifiant puis relancez.";
    const html = render({ phase: "error", errorText: message });
    expect(html).not.toContain("<button");
    expect(html).toContain("run.launchFailed");
    expect(html).toContain(`>${message}</p>`);
  });

  it("keeps the launch call's error under the line when the call errored with a run id", () => {
    const html = render({
      runId: "run_1",
      initialStatus: "running",
      phase: "error",
      errorText: "Délai d'attente dépassé",
    });
    expect(html).toContain(">Délai d&#x27;attente dépassé</p>");
  });

  it("states a failed run's short outcome on the line, with one cross only", () => {
    const html = render({ runId: "run_1", initialStatus: "failed" });
    expect(html).toContain("run.status.failed");
    expect(html.match(/<svg[^>]*lucide-circle-x/g)?.length).toBe(1);
    expect(html).not.toContain("lucide-x ");
    expect(html).not.toContain('role="img" aria-label="tool.failed');
  });

  it("is no button for a reader who cannot read the run, its notice under the line", () => {
    const html = render(
      { runId: "run_1", initialStatus: "running" },
      { host: { can: () => false, canIn: () => false } },
    );
    expect(html).not.toContain("<button");
    expect(html).not.toContain('title="run.openPage"');
    expect(html).not.toContain("run.starting");
    expect(html).toContain(">run.noAccess</p>");
  });

  it("anchors the panel's reveal on its root", () => {
    const html = render({ toolCallId: "call_1", runId: "run_1", initialStatus: "running" });
    expect(rooted(html)).toMatch(
      /^<div data-tool-call-id="call_1" data-run-id="run_1" tabindex="-1"/,
    );
    expect(rootClass(html)).toContain("data-[revealed]:ring-2");
  });
});

/** The visually hidden status region's text: what the line announces. */
const announced = (html: string) =>
  /<span role="status" class="sr-only">([^<]*)<\/span>/.exec(html)?.[1];

describe("what a run's line announces", () => {
  it("announces the settled outcome", () => {
    expect(announced(render({ runId: "run_1", initialStatus: "success", phase: "success" }))).toBe(
      "run.status.success",
    );
    expect(announced(render({ phase: "error", errorText: "refusé" }))).toBe("run.launchFailed");
    expect(
      announced(
        render(
          { runId: "run_1", initialStatus: "running" },
          { host: { can: () => false, canIn: () => false } },
        ),
      ),
    ).toBe("run.noAccess");
  });

  it("announces nothing while the run goes", () => {
    expect(announced(render({ runId: "run_1", initialStatus: "running" }))).toBe("");
  });
});
