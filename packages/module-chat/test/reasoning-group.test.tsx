// SPDX-License-Identifier: Apache-2.0

/**
 * The thought block of an assistant turn (#1601), through the real
 * assistant-ui runtime: reasoning and the tool calls the agent makes along the
 * way fold into one collapsible block per run of consecutive steps (a created
 * package included: its link closes the block), and the cards the user acts on
 * stay out of it. Without our own components the bubble stayed blank for the
 * whole reasoning phase (assistant-ui's default `Reasoning` renders nothing).
 *
 * The whole `Thread` renders, as the chat page mounts it: the seam is the
 * module's public component, not an export made for this file. SSR only, like
 * `turn-error-runtime.test.tsx`: the runtime derives every message status
 * during render. The block is folded until the reader opens it, a click this
 * DOM-less harness cannot drive: its header line is what renders here, and the
 * step rows are rendered on their own, inside the block's context, below.
 */

import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";

import { ChatHostProvider } from "../src/ui/runtime-context.ts";
import { testHost } from "./test-host.ts";
import { Thread } from "../src/ui/thread.tsx";
import { createMessageQueue } from "../src/ui/message-queue.ts";
import { ToolCallCard } from "../src/ui/tool-uis.tsx";
import { ThoughtGroupContext } from "../src/ui/use-in-thought-group.ts";
import { SearchIcon } from "lucide-react";

type ChatHelpers = Parameters<typeof useAISDKRuntime>[0];
type Parts = ChatHelpers["messages"][number]["parts"];

const REASONING = "Je dois d'abord lister les agents.";
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

const host = testHost();

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
/** The thinking dots: THE status region, one at most per turn, carrying the e2e/bench hook. */
const dots = (html: string) =>
  count(html, 'role="status" aria-label="thinking.status" data-testid="chat-thinking-status"');
/** Thought blocks: each has one disclosure trigger (folded, its steps are not mounted). */
const reasoningRows = (html: string) => count(html, "aria-expanded=");
const openRows = (html: string) => count(html, 'aria-expanded="true"');
const steps = (html: string) => count(html, 'data-testid="tool-call"');

const reasoning = (text: string, state: "streaming" | "done") =>
  ({ type: "reasoning", text, state }) as const;

const pendingToolCall = {
  type: "dynamic-tool",
  toolName: "list_agents",
  toolCallId: "call_1",
  state: "input-available",
  input: {},
} as const;

const toolOutput = (payload: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
});

describe("the thought block of an assistant turn", () => {
  it('reads "thinking" while the model reasons, with nothing to unfold yet', () => {
    const html = render([reasoning(REASONING, "streaming")]);
    expect(html).toContain("reasoning.running");
    expect(reasoningRows(html)).toBe(1);
    expect(openRows(html)).toBe(0);
    // One reasoning step: the header says it all, the trigger is inert.
    expect(html).toContain("disabled");
    expect(dots(html)).toBe(1);
  });

  it("keeps the dots on the line between the end of the reasoning and the next part", () => {
    const html = render([reasoning(REASONING, "done")]);
    expect(html).toContain("reasoning.running");
    expect(dots(html)).toBe(1);
  });

  it("settles to a folded line without dots once the answer starts", () => {
    // The streaming answer itself renders empty under SSR (MarkdownText's
    // smoothing drains on the client): the line's settled state is the point.
    const html = render([
      reasoning(REASONING, "done"),
      { type: "text", text: "Voici vos agents.", state: "streaming" },
    ]);
    expect(html).toContain("reasoning.done");
    expect(html).not.toContain("reasoning.running");
    expect(dots(html)).toBe(0);
    expect(openRows(html)).toBe(0);
    expect(html).not.toContain(REASONING);
  });

  it("names the step in progress and counts the steps, still folded", () => {
    const html = render([reasoning(REASONING, "done"), pendingToolCall]);
    expect(reasoningRows(html)).toBe(1);
    expect(openRows(html)).toBe(0);
    // The running call is the line: its label, then the step count.
    expect(html).toContain("list_agents");
    expect(html).not.toContain("reasoning.running");
    expect(html).toContain("reasoning.steps");
    // Folded: the steps are not mounted, the one set of dots is the block's.
    expect(steps(html)).toBe(0);
    expect(dots(html)).toBe(1);
  });

  it("coalesces reasoning and tool calls into one block", () => {
    const html = render([
      reasoning(REASONING, "done"),
      pendingToolCall,
      // Settled text: a streaming part renders empty under SSR (smoothing drains on the client).
      reasoning(REASONING_AFTER_TOOL, "done"),
    ]);
    expect(reasoningRows(html)).toBe(1);
    expect(dots(html)).toBe(1);
  });

  it("folds a created package into the block: no card of its own", () => {
    const html = render([
      reasoning(REASONING, "done"),
      {
        type: "dynamic-tool",
        toolName: "invoke_operation",
        toolCallId: "call_create",
        state: "output-available",
        input: { operation_id: "createAgent" },
        output: toolOutput({ status: 201, body: { id: "@acme/report" } }),
      },
    ]);
    expect(reasoningRows(html)).toBe(1);
    expect(steps(html)).toBe(0);
    // The block is the tail: it holds the status region, not a trailing indicator.
    expect(dots(html)).toBe(1);
  });

  it("stops the dots on a turn that failed mid-reasoning", () => {
    const html = render(
      [reasoning(REASONING, "streaming")],
      "error",
      new Error("appstrate:chat-turn-error:upstream_unavailable"),
    );
    expect(html).toContain("reasoning.done");
    expect(dots(html)).toBe(0);
    expect(html).toContain('role="alert"');
  });

  it("stops the dots on a turn stopped mid-reasoning", () => {
    // `stop()` aborts the stream: the part never reaches `done`, the chat is ready.
    const html = render([reasoning(REASONING, "streaming")], "ready");
    expect(html).toContain("reasoning.done");
    expect(dots(html)).toBe(0);
  });

  it("replays a finished turn with its settled line above the answer", () => {
    const html = render(
      [reasoning(REASONING, "done"), { type: "text", text: "Voici vos agents.", state: "done" }],
      "ready",
    );
    expect(html).toContain("reasoning.done");
    expect(dots(html)).toBe(0);
    expect(html.indexOf("reasoning.done")).toBeLessThan(html.indexOf("Voici vos agents."));
  });

  it("leaves a turn without reasoning as it was: the loading line, then the answer alone", () => {
    const waiting = render([]);
    expect(dots(waiting)).toBe(1);
    expect(waiting).toContain("reasoning.running");
    expect(reasoningRows(waiting)).toBe(0);

    const answered = render([{ type: "text", text: "Voici vos agents.", state: "done" }], "ready");
    expect(answered).toContain("Voici vos agents.");
    expect(dots(answered)).toBe(0);
    expect(answered).not.toContain("reasoning.");
  });

  it("never receives a reasoning part without readable text: the loading line stays", () => {
    // `ThoughtGroup` relies on assistant-ui dropping blank reasoning parts
    // (`thread-message-like.js`), so every step it renders has text to expand.
    const html = render([reasoning(" \n", "streaming")]);
    expect(reasoningRows(html)).toBe(0);
    expect(dots(html)).toBe(1);
  });
});

/** One step row, as the unfolded block renders it. */
function renderStep(props: Partial<Parameters<typeof ToolCallCard>[0]>) {
  return renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <ChatHostProvider value={host}>
        <ThoughtGroupContext.Provider value={true}>
          <ToolCallCard
            phase="success"
            Icon={SearchIcon}
            label="list_agents"
            args={{}}
            result={undefined}
            toolCallId="call_1"
            {...props}
          />
        </ThoughtGroupContext.Provider>
      </ChatHostProvider>
    </QueryClientProvider>,
  );
}

describe("a step row of the thought block", () => {
  it("ends with a status glyph, not the HTTP code", () => {
    const html = renderStep({ result: toolOutput({ status: 201, body: { id: "x" } }) });
    expect(html).toContain('aria-label="tool.stepDone"');
    expect(html).toContain("HTTP 201");
    // The code is in the glyph's tooltip only, never a badge.
    expect(html).not.toContain(">201<");
  });

  it("marks a failure with one small cross: no red border, no inline error", () => {
    const html = renderStep({
      phase: "error",
      isError: true,
      result: toolOutput({ status: 409, body: { detail: "device_busy" } }),
    });
    expect(html).toContain('data-phase="error"');
    expect(html).toContain('aria-label="tool.stepFailed"');
    expect(html).not.toContain("border-destructive");
    // The error message waits in the step's detail, one click away.
    expect(html).not.toContain("device_busy");
  });
});
