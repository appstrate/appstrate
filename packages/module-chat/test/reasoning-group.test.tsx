// SPDX-License-Identifier: Apache-2.0

/**
 * The reasoning phase of an assistant turn (#1601), through the real
 * assistant-ui runtime. assistant-ui hides `Empty` (the thinking dots) as soon
 * as the last part is `reasoning`, and its default `Reasoning` renders nothing,
 * so without our own components the bubble stayed blank for the whole
 * reasoning phase.
 *
 * The whole `Thread` renders, as the chat page mounts it: the seam is the
 * module's public component, not an export made for this file. SSR only, like
 * `turn-error-runtime.test.tsx`: the runtime derives every message status
 * during render. The group's open state follows the stream (open while its run
 * of reasoning is the part still streaming, folded once the turn moves on);
 * the reader's own toggle is a click, which this DOM-less harness cannot drive.
 */

import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";

import { ChatHostProvider, type ChatHost } from "../src/ui/runtime-context.ts";
import { Thread } from "../src/ui/thread.tsx";

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

const host: ChatHost = {
  openFile: () => {},
  downloadFile: () => {},
  useFileImageSrc: () => null,
  t: (key) => key,
  can: () => true,
  personalModelCredentials: true,
  formatBytes: String,
};

function Turn({ helpers }: { helpers: ChatHelpers }) {
  const runtime = useAISDKRuntime(helpers);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  );
}

function render(parts: Parts, status: ChatHelpers["status"] = "streaming", error?: Error) {
  return renderToString(
    <ChatHostProvider value={host}>
      <Turn helpers={chat(parts, status, error)} />
    </ChatHostProvider>,
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;
/** The thinking dots: THE status region, one at most per turn, carrying the e2e/bench hook. */
const dots = (html: string) =>
  count(html, 'role="status" aria-label="thinking.status" data-testid="chat-thinking-status"');
const reasoningRows = (html: string) => count(html, "aria-expanded=");
const openRows = (html: string) => count(html, 'aria-expanded="true"');

const reasoning = (text: string, state: "streaming" | "done") =>
  ({ type: "reasoning", text, state }) as const;

const pendingToolCall = {
  type: "dynamic-tool",
  toolName: "list_agents",
  toolCallId: "call_1",
  state: "input-available",
  input: {},
} as const;

describe("the reasoning phase of an assistant turn", () => {
  it("shows a running reasoning row, open, while the model reasons", () => {
    const html = render([reasoning(REASONING, "streaming")]);
    expect(html).toContain("reasoning.running");
    expect(reasoningRows(html)).toBe(1);
    // Open while it is the part still streaming: it holds the dots' place.
    expect(openRows(html)).toBe(1);
    expect(dots(html)).toBe(1);
  });

  it("keeps the dots on the row between the end of the reasoning and the next part", () => {
    const html = render([reasoning(REASONING, "done")]);
    expect(html).toContain("reasoning.running");
    expect(dots(html)).toBe(1);
  });

  it("settles to a collapsed row without dots once the answer starts", () => {
    // The streaming answer itself renders empty under SSR (MarkdownText's
    // smoothing drains on the client): the row's settled state is the point.
    const html = render([
      reasoning(REASONING, "done"),
      { type: "text", text: "Voici vos agents.", state: "streaming" },
    ]);
    expect(html).toContain("reasoning.done");
    expect(html).not.toContain("reasoning.running");
    expect(dots(html)).toBe(0);
    // Folded once the answer moves on: the reasoning text is not mounted.
    expect(openRows(html)).toBe(0);
    expect(html).not.toContain(REASONING);
  });

  it("hands the dots back to the thinking indicator while a tool call runs", () => {
    const html = render([reasoning(REASONING, "done"), pendingToolCall]);
    expect(html).toContain("reasoning.done");
    expect(html).not.toContain("reasoning.running");
    expect(dots(html)).toBe(1);
  });

  it("gives reasoning split by a tool call one row per run, only the tail running", () => {
    const html = render([
      reasoning(REASONING, "done"),
      pendingToolCall,
      reasoning(REASONING_AFTER_TOOL, "streaming"),
    ]);
    expect(reasoningRows(html)).toBe(2);
    expect(openRows(html)).toBe(1);
    expect(html.indexOf("reasoning.done")).toBeLessThan(html.indexOf("reasoning.running"));
    expect(dots(html)).toBe(1);
    // The settled run before the tool call is folded.
    expect(html).not.toContain(REASONING);
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

  it("replays a finished turn with its settled row above the answer", () => {
    const html = render(
      [reasoning(REASONING, "done"), { type: "text", text: "Voici vos agents.", state: "done" }],
      "ready",
    );
    expect(html).toContain("reasoning.done");
    expect(dots(html)).toBe(0);
    expect(html.indexOf("reasoning.done")).toBeLessThan(html.indexOf("Voici vos agents."));
  });

  it("leaves a turn without reasoning as it was: dots, then the answer alone", () => {
    const waiting = render([]);
    expect(dots(waiting)).toBe(1);
    expect(reasoningRows(waiting)).toBe(0);

    const answered = render([{ type: "text", text: "Voici vos agents.", state: "done" }], "ready");
    expect(answered).toContain("Voici vos agents.");
    expect(dots(answered)).toBe(0);
    expect(answered).not.toContain("reasoning.");
  });

  it("never receives a reasoning part without readable text: the dots stay", () => {
    // `ReasoningGroup` relies on assistant-ui dropping blank reasoning parts
    // (`thread-message-like.js`), so every row it renders has text to expand.
    const html = render([reasoning(" \n", "streaming")]);
    expect(html).not.toContain("reasoning.");
    expect(reasoningRows(html)).toBe(0);
    expect(dots(html)).toBe(1);
  });
});
