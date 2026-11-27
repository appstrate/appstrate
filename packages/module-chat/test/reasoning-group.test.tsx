// SPDX-License-Identifier: Apache-2.0

/**
 * An assistant turn's activity (#1601, #2443), through the real assistant-ui
 * runtime: its reasoning and its tool calls on one line, the turn's status
 * while it runs. `GroupedParts` emits no `indicator` part (the loading line)
 * once the last part is `reasoning`, and its default `Reasoning` renders
 * nothing, so without our own components the bubble stayed blank for the
 * whole reasoning phase.
 *
 * The whole `Thread` renders, as the chat page mounts it: the seam is the
 * module's public component, not an export made for this file. SSR only, like
 * `turn-error-runtime.test.tsx`: the runtime derives every message status
 * during render. A group is folded until its reader opens it, a click this
 * DOM-less harness cannot drive: the context panel's reveal opens it instead.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";

import { ChatHostProvider } from "../src/ui/runtime-context.ts";
import { testHost } from "./test-host.ts";
import { Thread } from "../src/ui/thread.tsx";
import { createMessageQueue } from "../src/ui/message-queue.ts";
import { forgetRevealedToolCalls, revealToolCall } from "../src/ui/reveal-tool-call.ts";

type ChatHelpers = Parameters<typeof useAISDKRuntime>[0];
type Parts = ChatHelpers["messages"][number]["parts"];

/** Its first line is the settled row's title; the rest shows only once the row is opened. */
const REASONING_TITLE = "Lister les agents.";
const REASONING_BODY = "Puis les compter un par un.";
const REASONING = `**${REASONING_TITLE}**\n\n${REASONING_BODY}`;
const REASONING_AFTER_TOOL = "La liste est vide, je le signale.";

function chat(parts: Parts, status: ChatHelpers["status"], error?: Error): ChatHelpers {
  const noop = async () => {};
  return {
    id: "chat_1",
    messages: [
      { id: "msg_user", role: "user", parts: [{ type: "text", text: "Bonjour" }] },
      { id: "msg_assistant", role: "assistant", parts },
    ],
    status,
    error,
    setMessages: () => {},
    sendMessage: noop,
    regenerate: noop,
    stop: noop,
    resumeStream: noop,
    addToolResult: noop,
    addToolOutput: noop,
    addToolApprovalResponse: noop,
    clearError: () => {},
  };
}

// Keys echoed, with the HTTP status appended when the key is given one.
const host = testHost({
  t: (key, options) => (options?.status === undefined ? key : `${key}:${options.status}`),
});

function Turn({ helpers }: { helpers: ChatHelpers }) {
  const runtime = useAISDKRuntime(helpers);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread messageQueue={createMessageQueue()} />
    </AssistantRuntimeProvider>
  );
}

function render(parts: Parts, status: ChatHelpers["status"] = "streaming", error?: Error) {
  return renderToString(
    // The composer below the turn reads the `/` menu's commands.
    <QueryClientProvider client={new QueryClient()}>
      <ChatHostProvider value={host}>
        <Turn helpers={chat(parts, status, error)} />
      </ChatHostProvider>
    </QueryClientProvider>,
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;
/** The thinking loader: THE status region, one at most per turn, carrying the e2e/bench hook. */
const statusRegions = (html: string) =>
  count(html, 'role="status" aria-label="thinking.status" data-testid="chat-thinking-status"');
/** Every disclosure the turn draws: a group's line, and its steps once it is open. */
const disclosures = (html: string) => count(html, "aria-expanded=");
const openDisclosures = (html: string) => count(html, 'aria-expanded="true"');
/** The first group's line: what sits inside its trigger. */
const groupTrigger = (html: string) =>
  html.match(/<button[^>]*aria-expanded[^>]*>.*?<\/button>/s)?.[0] ?? "";

const reasoning = (text: string, state: "streaming" | "done") =>
  ({ type: "reasoning", text, state }) as const;

/** A call the engine did not stamp a lookup: counted as an action. */
const pendingToolCall = {
  type: "dynamic-tool",
  toolName: "list_agents",
  toolCallId: "call_1",
  state: "input-available",
  input: {},
} as const;

/** A call the engine stamped a lookup before it ran: counted as a consultation. */
const lookup = (id: string, query: string, done = true) =>
  ({
    type: "dynamic-tool",
    toolName: "search",
    toolCallId: id,
    input: { query },
    callProviderMetadata: { appstrate: { lookup: true } },
    ...(done
      ? { state: "output-available", output: { results: [] } }
      : { state: "input-available" }),
  }) as const;

const answer = { type: "text", text: "Voici vos agents.", state: "done" } as const;

const globals = globalThis as { document?: unknown; CSS?: unknown };
/** The panel reveals a call: its group opens; this page draws no step, so none takes focus. */
const reveal = (toolCallId: string) => {
  globals.document = {
    querySelector: (selector: string) =>
      selector === "[data-chat-thread]" ? { querySelector: () => null } : null,
  };
  globals.CSS = { escape: (value: string) => value };
  revealToolCall({ toolCallId });
};
const REVEALED = ["s1", "call_failed"];
afterEach(() => {
  forgetRevealedToolCalls(REVEALED);
  delete globals.document;
  delete globals.CSS;
});

describe("the reasoning of an assistant turn", () => {
  it("is the turn's line while the model reasons: the spark, its first line shimmering, folded", () => {
    const html = render([reasoning(REASONING, "streaming")]);
    expect(statusRegions(html)).toBe(1);
    expect(disclosures(html)).toBe(1);
    expect(openDisclosures(html)).toBe(0);
    const trigger = groupTrigger(html);
    expect(trigger).toContain("shimmer-text");
    expect(trigger).toContain(REASONING_TITLE);
    expect(trigger).not.toContain('role="status"');
    // Folded: the reasoning text is not mounted.
    expect(html).not.toContain(REASONING_BODY);
  });

  it("reads « thinking » until the reasoning has a first line", () => {
    const html = render([reasoning("**", "streaming")]);
    expect(groupTrigger(html)).toContain("reasoning.running");
  });

  it("keeps the spark on the line between the end of the reasoning and the next part", () => {
    const html = render([reasoning(REASONING, "done")]);
    expect(statusRegions(html)).toBe(1);
    expect(groupTrigger(html)).toContain("shimmer-text");
  });

  it("settles to its first line, without spark or shimmer, once the answer starts", () => {
    // The streaming answer itself renders empty under SSR (MarkdownText's
    // smoothing drains on the client): the line's settled state is the point.
    const html = render([
      reasoning(REASONING, "done"),
      { type: "text", text: "Voici vos agents.", state: "streaming" },
    ]);
    // Settled, the line reads the reasoning's first line, without its markdown.
    expect(html).toContain(REASONING_TITLE);
    expect(html).not.toContain(`**${REASONING_TITLE}`);
    expect(html).not.toContain("reasoning.done");
    expect(html).not.toContain("reasoning.running");
    expect(html).not.toContain("shimmer-text");
    expect(statusRegions(html)).toBe(0);
    expect(openDisclosures(html)).toBe(0);
    expect(html).not.toContain(REASONING_BODY);
  });

  it("shares its line with the tool call that follows: one group, naming the call that runs", () => {
    const html = render([reasoning(REASONING, "done"), pendingToolCall]);
    expect(disclosures(html)).toBe(1);
    expect(statusRegions(html)).toBe(1);
    expect(groupTrigger(html)).toContain("tool.name.list_agents");
    // No loading line beside it.
    expect(html).not.toContain("reasoning.running");
  });

  it("keeps reasoning split by a tool call on one line, reading the reasoning in progress", () => {
    const html = render([
      reasoning(REASONING, "done"),
      pendingToolCall,
      reasoning(REASONING_AFTER_TOOL, "streaming"),
    ]);
    expect(disclosures(html)).toBe(1);
    expect(statusRegions(html)).toBe(1);
    expect(groupTrigger(html)).toContain(REASONING_AFTER_TOOL);
    expect(html).not.toContain(REASONING_BODY);
  });

  it("stops the spark on a turn that failed mid-reasoning", () => {
    const html = render(
      [reasoning(REASONING, "streaming")],
      "error",
      new Error("appstrate:chat-turn-error:upstream_unavailable"),
    );
    expect(html).toContain(REASONING_TITLE);
    expect(html).not.toContain("shimmer-text");
    expect(statusRegions(html)).toBe(0);
    expect(html).toContain('role="alert"');
  });

  it("stops the spark on a turn stopped mid-reasoning", () => {
    // `stop()` aborts the stream: the part never reaches `done`, the chat is ready.
    const html = render([reasoning(REASONING, "streaming")], "ready");
    expect(html).toContain(REASONING_TITLE);
    expect(html).not.toContain("shimmer-text");
    expect(statusRegions(html)).toBe(0);
  });

  it("replays a finished turn with its settled line above the answer", () => {
    const html = render([reasoning(REASONING, "done"), answer], "ready");
    expect(html).toContain(REASONING_TITLE);
    expect(statusRegions(html)).toBe(0);
    expect(html.indexOf(REASONING_TITLE)).toBeLessThan(html.indexOf("Voici vos agents."));
  });

  it("leaves a turn without activity as it was: the loading line, then the answer alone", () => {
    const waiting = render([]);
    expect(statusRegions(waiting)).toBe(1);
    expect(disclosures(waiting)).toBe(0);
    expect(waiting).toContain("reasoning.running");

    const answered = render([answer], "ready");
    expect(answered).toContain("Voici vos agents.");
    expect(statusRegions(answered)).toBe(0);
    expect(answered).not.toContain("reasoning.");
  });

  it("never receives a reasoning part without readable text: the loading line stays", () => {
    // assistant-ui drops blank reasoning parts (`thread-message-like.js`), so
    // every reasoning step has text to open.
    const html = render([reasoning(" \n", "streaming")]);
    expect(html).not.toContain("reasoning.done");
    expect(disclosures(html)).toBe(0);
    expect(statusRegions(html)).toBe(1);
  });

  it("draws the status region as the spark: four balls, in the line's lead slot", () => {
    const html = render([]);
    expect(statusRegions(html)).toBe(1);
    expect(html).toMatch(/<span class="flex size-4 items-center justify-center" role="status"/);
    expect(html).toContain('<span class="spark"');
    expect(count(html, "<i></i>")).toBe(4);
    expect(html).not.toContain("animate-bounce");
  });

  it("titles a settled line without words in its text with the generic label", () => {
    const html = render([reasoning("**", "done"), answer], "ready");
    expect(html).toContain("reasoning.done");
  });

  it("opens with its group when it is the group's one step", () => {
    // Nothing but a click opens a group of reasoning alone; the step's own state is `solo`.
    reveal("s1");
    const html = render([lookup("s1", "issues"), answer], "ready");
    // The group's line and its one step, both open: the step's detail is mounted.
    expect(disclosures(html)).toBe(2);
    expect(openDisclosures(html)).toBe(2);
    expect(html).toContain("tool.detail.input");
  });
});

describe("a running turn's one status region, whatever its tail", () => {
  it("is the group's line from its first call, naming the call that runs", () => {
    const html = render([lookup("s1", "issues", false)]);
    expect(statusRegions(html)).toBe(1);
    expect(disclosures(html)).toBe(1);
    const trigger = groupTrigger(html);
    expect(trigger).not.toContain('role="status"');
    // The step in progress as `showCall` names it, then its target; no count while it runs.
    expect(trigger).toContain("shimmer-text");
    expect(trigger.indexOf("issues")).toBeGreaterThan(trigger.indexOf("tool.name.search"));
    expect(trigger).not.toContain("tool.reads.done");
    // No loading line after it: the line holds the turn's region.
    expect(html).not.toContain("reasoning.running");
    // The spark first, then the trigger.
    expect(html.indexOf("chat-thinking-status")).toBeLessThan(html.indexOf("tool.name.search"));
  });

  it("stays the same line when a second call joins: one disclosure, the call that runs", () => {
    const html = render([lookup("s1", "issues"), lookup("s2", "agents", false)]);
    expect(statusRegions(html)).toBe(1);
    expect(disclosures(html)).toBe(1);
    const trigger = groupTrigger(html);
    expect(trigger).toContain("agents");
    expect(trigger).not.toContain("issues");
  });

  it("reads « thinking » on the line while the model thinks after a call's result", () => {
    const html = render([lookup("s1", "issues")]);
    expect(statusRegions(html)).toBe(1);
    expect(groupTrigger(html)).toContain("reasoning.running");
    expect(count(html, "reasoning.running")).toBe(1);
  });

  it("is still the line alone with the group opened by the context panel", () => {
    reveal("s1");
    const html = render([
      lookup("s1", "issues"),
      lookup("s2", "agents"),
      reasoning(REASONING, "streaming"),
    ]);
    // Open: the line, two call steps, and the reasoning step, open while it streams.
    expect(disclosures(html)).toBe(4);
    expect(openDisclosures(html)).toBe(2);
    expect(count(html, "lucide-brain")).toBe(1);
    expect(statusRegions(html)).toBe(1);
  });

  it("is gone once the turn ends, the line back to its counts", () => {
    const html = render([lookup("s1", "issues"), lookup("s2", "agents"), answer], "ready");
    expect(statusRegions(html)).toBe(0);
    const trigger = groupTrigger(html);
    expect(trigger).toContain("tool.reads.done");
    expect(trigger).not.toContain("tool.name.search");
    expect(trigger).not.toContain("shimmer-text");
  });
});

describe("a settled group's line", () => {
  it("names its one call, with its target, rather than counting it", () => {
    const trigger = groupTrigger(render([lookup("s1", "issues"), answer], "ready"));
    expect(trigger.indexOf("issues")).toBeGreaterThan(trigger.indexOf("tool.name.search"));
    expect(trigger).not.toContain("tool.reads.done");
  });

  it("counts consultations and actions apart", () => {
    const done = { ...pendingToolCall, state: "output-available", output: { agents: [] } } as const;
    const trigger = groupTrigger(render([lookup("s1", "issues"), done, answer], "ready"));
    expect(trigger.indexOf("tool.actions.done")).toBeGreaterThan(
      trigger.indexOf("tool.reads.done"),
    );
  });

  it("starts a new line after a text", () => {
    const html = render([lookup("s1", "issues"), answer, lookup("s2", "agents"), answer], "ready");
    expect(disclosures(html)).toBe(2);
  });
});

const failedCall = (output: unknown) =>
  ({
    type: "dynamic-tool",
    toolName: "list_agents",
    toolCallId: "call_failed",
    state: "output-available",
    input: {},
    output,
  }) as const;

describe("a failed tool call, softened and never hidden", () => {
  const failed = [failedCall({ status: 404, error: "Agent introuvable" }), answer];

  it("marks its folded line with a decorative cross and a muted count", () => {
    const trigger = groupTrigger(render(failed, "ready"));
    // The cross is decorative beside the count that says the failure: said once.
    expect(trigger).toContain('aria-hidden="true" class="text-destructive shrink-0"');
    expect(trigger).not.toContain('aria-label="tool.failed');
    expect(trigger).toContain("tool.reads.failed");
    expect(trigger).not.toMatch(/class="text-destructive"[^>]*>tool\.reads\.failed/);
  });

  it("keeps its error under its step, muted, the cross naming the failure and its HTTP status", () => {
    reveal("call_failed");
    const html = render(failed, "ready");
    expect(html).not.toContain("border-destructive");
    expect(html).toMatch(/<p class="text-muted-foreground[^"]*"[^>]*>Agent introuvable</);
    expect(html).toContain('aria-label="tool.failedHttp:404"');
    expect(html).not.toContain('title="tool.failed');
  });

  it("shows no HTTP badge, failed or not", () => {
    reveal("call_failed");
    const ok = render([failedCall({ status: 200, results: [] }), answer], "ready");
    expect(ok).not.toContain("tool.failed");
    expect(ok).not.toContain("text-destructive");
    expect(ok).not.toContain(">200<");
    expect(render(failed, "ready")).not.toContain(">404<");
  });

  it("shows the failure on the line while the turn still runs", () => {
    const html = render([
      lookup("s1", "issues"),
      { ...lookup("s2", "agents"), output: { status: 500, error: "boom" } },
      lookup("s3", "runs", false),
    ]);
    const trigger = groupTrigger(html);
    expect(trigger).toContain("tool.name.search");
    expect(trigger).toContain('class="text-destructive shrink-0"');
    expect(trigger).toContain("tool.reads.failed");
  });
});
