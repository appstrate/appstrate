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
import { AssistantRuntimeProvider, ThreadPrimitive } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";

import { ChatHostProvider } from "../src/ui/runtime-context.ts";
import { testHost } from "./test-host.ts";
import { Thread } from "../src/ui/thread.tsx";
import { ReasoningStep } from "../src/ui/reasoning.tsx";
import { ActivityModeContext } from "../src/ui/activity-mode.ts";
import { createMessageQueue } from "../src/ui/message-queue.ts";
import { forgetRevealedToolCalls, revealThreadItem } from "../src/ui/reveal-tool-call.ts";

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

/**
 * A group's one reasoning step, opened: a click this harness cannot drive opens a group of
 * reasoning alone, so the step renders in the mode the group gives its one step.
 */
function renderSoloReasoning() {
  function SoloReasoning() {
    return (
      <ActivityModeContext value={{ mode: "step", solo: true }}>
        <ReasoningStep indices={[0]}>
          <p>{REASONING_BODY}</p>
        </ReasoningStep>
      </ActivityModeContext>
    );
  }
  function SoloTurn() {
    const runtime = useAISDKRuntime(chat([reasoning(REASONING, "done")], "ready"));
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Messages
          components={{ UserMessage: () => null, AssistantMessage: SoloReasoning }}
        />
      </AssistantRuntimeProvider>
    );
  }
  return renderToString(
    <ChatHostProvider value={host}>
      <SoloTurn />
    </ChatHostProvider>,
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
const statusRegions = (html: string) => count(html, 'data-testid="chat-thinking-status"');
/** What the status region announces: the step in progress, as visually hidden text. */
const announced = (html: string) =>
  /data-testid="chat-thinking-status">.*?<span class="sr-only">([^<]*)<\/span>/s.exec(html)?.[1];
/** Every disclosure the turn draws: a group's line, and its steps once it is open. */
const disclosures = (html: string) => count(html, "aria-expanded=");
const openDisclosures = (html: string) => count(html, 'aria-expanded="true"');
/** The first group's line: what sits inside its trigger. */
const groupTrigger = (html: string) =>
  html.match(/<button[^>]*aria-expanded[^>]*>.*?<\/button>/s)?.[0] ?? "";
/** The first call's line: its button, opening it in the context panel, no disclosure. */
const callButton = (html: string) =>
  html.match(
    /data-tool-call-id="[^"]*"[^>]*>.*?(<button(?![^>]*aria-expanded)[^>]*>.*?<\/button>)/s,
  )?.[1] ?? "";
/** The calls' lines the panel locates by their anchor. */
const callLines = (html: string) => count(html, "data-tool-call-id=");

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
  revealThreadItem({ kind: "call", id: toolCallId });
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

  it("reads « thinking » until the reasoning's first line is whole", () => {
    const trigger = groupTrigger(render([reasoning("Lister les", "streaming")]));
    expect(trigger).toContain("reasoning.running");
    expect(trigger).not.toContain("Lister les");
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

  it("keeps reasoning split by a tool call on one line, the model thinking again", () => {
    const html = render([
      reasoning(REASONING, "done"),
      pendingToolCall,
      reasoning(REASONING_AFTER_TOOL, "streaming"),
    ]);
    expect(disclosures(html)).toBe(1);
    expect(statusRegions(html)).toBe(1);
    expect(groupTrigger(html)).toContain("reasoning.running");
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

  it("names the run a message ends on while it runs, not the model thinking", () => {
    const run = {
      type: "dynamic-tool",
      toolName: "run_and_wait",
      toolCallId: "call_run",
      state: "input-available",
      input: { kind: "agent", scope: "@acme", name: "digest" },
    } as const;
    const html = render([run]);
    expect(statusRegions(html)).toBe(1);
    expect(html).not.toContain("reasoning.running");
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
    expect(html).toMatch(/<span aria-hidden="true" class="spark"/);
    expect(count(html, "<i></i>")).toBe(4);
    expect(html).not.toContain("animate-bounce");
  });

  it("settles a reasoning that says nothing past its title to a plain line, nothing to open", () => {
    const html = render([reasoning(`**${REASONING_TITLE}**`, "done"), answer], "ready");
    expect(count(html, REASONING_TITLE)).toBe(1);
    expect(disclosures(html)).toBe(0);
    expect(html).toContain("lucide-brain");
  });

  it("keeps a reasoning that says more than its title a disclosure", () => {
    const html = render([reasoning(REASONING, "done"), answer], "ready");
    expect(disclosures(html)).toBe(1);
    expect(count(html, REASONING_TITLE)).toBe(1);
  });

  it("titles a settled line without words in its text with the generic label", () => {
    const html = render([reasoning("**", "done"), answer], "ready");
    expect(html).toContain("reasoning.done");
  });

  it("is the call's own line when it is the group's one call: a button, nothing to unfold", () => {
    const counted = {
      ...lookup("s1", "issues"),
      resultProviderMetadata: {
        appstrate: { presentation: { call: "search", count: 3, items: [] } },
      },
    };
    const html = render([counted, answer], "ready");
    // No disclosure: a click opens the call in the context panel.
    expect(disclosures(html)).toBe(0);
    expect(html).not.toContain("lucide-chevron-right");
    const button = callButton(html);
    expect(button.indexOf(">issues<")).toBeGreaterThan(button.indexOf("tool.name.search"));
    expect(count(html, "tool.name.search")).toBe(1);
    // What follows the call's name is on the line itself, after the button; no detail in the thread.
    expect(html.indexOf("tool.search.count")).toBeGreaterThan(html.indexOf(button));
    expect(button).not.toContain("tool.search.count");
    expect(html).not.toContain("tool.detail.input");
    // The anchor the context panel reveals by is the line.
    expect(callLines(html)).toBe(1);
    expect(html).toContain('data-tool-call-id="s1"');
  });

  it("draws a group's one reasoning as its text alone, the line naming it", () => {
    const html = renderSoloReasoning();
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain(REASONING_TITLE);
    expect(html).toBe(`<div class="pb-2 pl-6"><p>${REASONING_BODY}</p></div>`);
  });
});

describe("a running turn's one status region, whatever its tail", () => {
  it("is the call's own line from its first chunk: the spark leading, its name shimmering", () => {
    const html = render([lookup("s1", "issues", false)]);
    expect(statusRegions(html)).toBe(1);
    // A lone call is never a disclosure: its line opens it in the panel, as once settled.
    expect(disclosures(html)).toBe(0);
    expect(callLines(html)).toBe(1);
    const button = callButton(html);
    expect(button).toContain("shimmer-text");
    expect(button.indexOf("issues")).toBeGreaterThan(button.indexOf("tool.name.search"));
    expect(button).not.toContain('role="status"');
    // Named by its line and announced by the region, no step line repeating it under the line.
    expect(count(html, "tool.name.search")).toBe(2);
    expect(announced(html)).toBe("tool.name.search");
    // No loading line after it: the line holds the turn's region.
    expect(count(html, "reasoning.running")).toBe(0);
    // The spark first, then the call's name.
    expect(html.indexOf("chat-thinking-status")).toBeLessThan(html.indexOf(button));
  });

  it("becomes the disclosure when a second call joins, naming the call that runs", () => {
    const html = render([lookup("s1", "issues"), lookup("s2", "agents", false)]);
    expect(statusRegions(html)).toBe(1);
    expect(disclosures(html)).toBe(1);
    const trigger = groupTrigger(html);
    expect(trigger).toContain("agents");
    expect(trigger).not.toContain("issues");
    expect(trigger).not.toContain('role="status"');
    expect(announced(html)).toBe("tool.name.search");
  });

  it("keeps the lone call's line while the model thinks after its result, the region saying so", () => {
    const html = render([lookup("s1", "issues")]);
    expect(statusRegions(html)).toBe(1);
    expect(disclosures(html)).toBe(0);
    const button = callButton(html);
    expect(button).toContain("tool.name.search");
    expect(button).not.toContain("shimmer-text");
    expect(announced(html)).toBe("reasoning.running");
  });

  it("announces the step in progress, the model thinking before its first line is whole", () => {
    expect(announced(render([reasoning("Lister les", "streaming")]))).toBe("reasoning.running");
    expect(announced(render([]))).toBe("reasoning.running");
  });

  it("is still the line alone with the group opened by the context panel", () => {
    reveal("s1");
    const html = render([
      lookup("s1", "issues"),
      lookup("s2", "agents"),
      reasoning(REASONING, "streaming"),
    ]);
    // Open: the line and the reasoning step, open while it streams, are disclosures; the two call
    // steps are lines opening their call in the panel.
    expect(disclosures(html)).toBe(2);
    expect(openDisclosures(html)).toBe(2);
    expect(callLines(html)).toBe(2);
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
    const trigger = callButton(render([lookup("s1", "issues"), answer], "ready"));
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
    expect(callLines(html)).toBe(2);
    expect(disclosures(html)).toBe(0);
  });

  it("opened, lists its calls as lines opening them in the panel, their detail not in the thread", () => {
    reveal("s1");
    const html = render([lookup("s1", "issues"), lookup("s2", "agents"), answer], "ready");
    // The group's line is the one disclosure, open; each call is a button of its own.
    expect(disclosures(html)).toBe(1);
    expect(openDisclosures(html)).toBe(1);
    expect(callLines(html)).toBe(2);
    expect(count(html, "<button")).toBeGreaterThanOrEqual(3);
    expect(html).not.toContain("tool.detail.input");
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
  const amongOthers = [lookup("s1", "issues"), ...failed];

  it("marks its folded group's line with a decorative cross and a muted count", () => {
    const trigger = groupTrigger(render(amongOthers, "ready"));
    // The cross is decorative beside the count that says the failure: said once.
    expect(trigger).toContain('aria-hidden="true" class="text-destructive shrink-0"');
    expect(trigger).not.toContain('aria-label="tool.failed');
    expect(trigger).toContain("tool.reads.failed");
    expect(trigger).not.toMatch(/class="text-destructive"[^>]*>tool\.reads\.failed/);
  });

  it("keeps its error under its step, muted, the cross naming the failure and its HTTP status", () => {
    reveal("call_failed");
    const html = render(amongOthers, "ready");
    expect(html).not.toContain("border-destructive");
    expect(html).toMatch(/<p class="text-muted-foreground[^"]*"[^>]*>Agent introuvable</);
    expect(html).toContain('aria-label="tool.failedHttp:404"');
    expect(html).not.toContain('title="tool.failed');
  });

  it("alone in its group, says its failure on the line, its message under it, without a click", () => {
    const html = render(failed, "ready");
    expect(disclosures(html)).toBe(0);
    // The cross ends the line, named; the message stays in view under it, muted.
    expect(html).toContain('aria-label="tool.failedHttp:404"');
    expect(html).not.toContain("tool.reads.failed");
    expect(html).toMatch(/<p class="text-muted-foreground[^"]*"[^>]*>Agent introuvable</);
    expect(html.indexOf("Agent introuvable")).toBeGreaterThan(html.indexOf("tool.failedHttp"));
    // Its name said once, by its line.
    expect(count(html, "tool.name.list_agents")).toBe(1);
  });

  it("shows no HTTP badge, failed or not", () => {
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
