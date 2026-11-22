// SPDX-License-Identifier: Apache-2.0

/**
 * A user message that names an agent or a skill, through the real assistant-ui runtime (SSR): each
 * is a chip inline in the text, from a live message or one replayed from history, and the launch
 * text the server wrote into the part is never shown.
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
const AGENT = ":agent[Weekly report]{name=run-report}";
const SKILL = ":skill[tone]{name=@acme/tone}";
const prompt = {
  type: "data-agent-prompt" as const,
  // As a replayed message holds it: the server's `text` is in the stored part.
  data: { name: "run-report", title: "Weekly report", text: LAUNCH },
};

describe("a user message that names an agent or a skill", () => {
  it("draws each as a chip inside the text, where it was typed, and never the launch text", () => {
    const html = render([{ type: "text", text: `${AGENT} for Q3 in the ${SKILL} style` }, prompt]);
    expect(html.match(/data-testid="directive-chip"/g)).toHaveLength(2);
    expect(html).toContain('data-directive-type="agent"');
    expect(html).toContain('data-directive-type="skill"');
    expect(html).toContain("Weekly report");
    expect(html).toContain("for Q3 in the");
    expect(html).not.toContain(LAUNCH);
    // The directive syntax is never shown.
    expect(html).not.toContain(":agent[");
    expect(html).not.toContain("run-report");
    expect(html.indexOf("Weekly report")).toBeLessThan(html.indexOf("for Q3"));
  });

  it("draws an agent chip alone in its bubble", () => {
    const html = render([{ type: "text", text: AGENT }, prompt]);
    expect(html).toContain("Weekly report");
    expect(html).toContain("rounded-2xl");
  });

  it("draws no bubble for a replayed launch with no text at all", () => {
    const html = render([prompt]);
    expect(html).not.toContain(LAUNCH);
    expect(html).not.toContain("rounded-2xl");
  });

  it("draws an ordinary message as before: a bubble, no chip", () => {
    const html = render([{ type: "text", text: "hello :smile[x]" }]);
    expect(html).toContain("hello :smile[x]");
    expect(html).not.toContain("directive-chip");
  });
});
