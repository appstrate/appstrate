// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's field through the real thread (SSR): a Lexical editor, not a textarea, named and
 * hinted as the textarea was, which the `/` menu and the directive chips are built on.
 */

import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";

import { ChatHostProvider } from "../src/ui/runtime-context.ts";
import { Thread } from "../src/ui/thread.tsx";
import { createMessageQueue } from "../src/ui/message-queue.ts";
import { testHost } from "./test-host.ts";

type ChatHelpers = Parameters<typeof useAISDKRuntime>[0];

function Page({ modelLabel }: { modelLabel?: string }) {
  const noop = async () => {};
  const runtime = useAISDKRuntime({
    id: "chat_1",
    messages: [],
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
  } satisfies ChatHelpers);
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ChatHostProvider value={{ ...testHost(), modelLabel }}>
        <AssistantRuntimeProvider runtime={runtime}>
          <Thread messageQueue={createMessageQueue()} />
        </AssistantRuntimeProvider>
      </ChatHostProvider>
    </QueryClientProvider>
  );
}

describe("the composer's field", () => {
  const html = renderToString(<Page modelLabel="Claude" />);

  it("is a named textbox that is not a textarea", () => {
    expect(html).toContain('role="textbox"');
    expect(html).toContain('contentEditable="true"');
    expect(html).toContain('aria-label="composer.placeholder"');
    expect(html).not.toContain("<textarea");
  });

  it("draws no menu until a / opens it", () => {
    expect(html).not.toContain("slash.loading");
    expect(html).not.toContain("slash-menu");
  });

  it("shows the model in its placeholder", () => {
    expect(html).toContain("composer.placeholderModel");
  });
});
