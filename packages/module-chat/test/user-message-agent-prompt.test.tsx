// SPDX-License-Identifier: Apache-2.0

/**
 * A user message that launched an agent, through the real assistant-ui runtime (SSR): the agent is
 * a chip above the bubble, from a live message or one replayed from history, and the launch text
 * the server wrote into the part is never shown.
 */

import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { AssistantRuntimeProvider, ThreadPrimitive } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";

import { ChatHostProvider } from "../src/ui/runtime-context.ts";
import { UserMessage } from "../src/ui/thread.tsx";
import { testHost } from "./test-host.ts";

type ChatHelpers = Parameters<typeof useAISDKRuntime>[0];

function chatOf(messages: UIMessage[]): ChatHelpers {
  const noop = async () => {};
  return {
    id: "chat_1",
    messages,
    status: "ready",
    error: undefined,
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

function Thread({ chat }: { chat: ChatHelpers }) {
  const runtime = useAISDKRuntime(chat);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage: () => null }} />
    </AssistantRuntimeProvider>
  );
}

function render(parts: UIMessage["parts"]): string {
  return renderToString(
    <ChatHostProvider value={testHost()}>
      <Thread chat={chatOf([{ id: "m1", role: "user", parts }])} />
    </ChatHostProvider>,
  );
}

const LAUNCH = "LAUNCH-INSTRUCTIONS-FROM-THE-SERVER";
const prompt = {
  type: "data-agent-prompt" as const,
  // As a replayed message holds it: the server's `text` is in the stored part.
  data: { name: "run-report", title: "Weekly report", text: LAUNCH },
};
const BUBBLE = "rounded-2xl";

describe("a user message that launched an agent", () => {
  it("draws the agent's title as a chip above the text, and never the launch text", () => {
    const html = render([{ type: "text", text: "for Q3" }, prompt]);
    expect(html).toContain('data-testid="agent-prompt-chip"');
    expect(html).toContain("Weekly report");
    expect(html).toContain("for Q3");
    expect(html).not.toContain(LAUNCH);
    expect(html.indexOf("agent-prompt-chip")).toBeLessThan(html.indexOf("for Q3"));
  });

  it("draws the chip alone, with no empty bubble, when nothing was typed", () => {
    const html = render([prompt]);
    expect(html).toContain("Weekly report");
    expect(html).not.toContain(LAUNCH);
    expect(html).not.toContain(BUBBLE);
  });

  it("draws an ordinary message as before: a bubble, no chip", () => {
    const html = render([{ type: "text", text: "hello" }]);
    expect(html).toContain("hello");
    expect(html).toContain(BUBBLE);
    expect(html).not.toContain("agent-prompt-chip");
  });

  it("draws no chip for a part that carries no usable title", () => {
    const html = render([
      { type: "text", text: "hello" },
      { type: "data-agent-prompt", data: {} },
    ]);
    expect(html).toContain("hello");
    expect(html).not.toContain("agent-prompt-chip");
  });
});
