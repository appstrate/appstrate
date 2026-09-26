// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #1582, end to end: a failed turn renders ITS sentence through the real
 * assistant-ui runtime, not the generic failure.
 *
 * `turn-error-state.test.ts` feeds `turnErrorState` a hand-built
 * `{ code, message }`; here the Error goes in where the AI SDK transport puts
 * it (`throw new Error(await response.text())`) and everything after is real.
 * `useAISDKRuntime` normalizes it with its private `toChatError`, and
 * `completeExternalMessageConversion` (`@assistant-ui/core`) appends an
 * assistant message with `status.reason: "error"` after the last user message.
 * Both run during render, so SSR is enough.
 */

import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { AssistantRuntimeProvider, ThreadPrimitive } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { conflict } from "@appstrate/core/api-errors";

import { ChatHostProvider, type ChatHost } from "../src/ui/runtime-context.ts";
import { MessageError } from "../src/ui/thread.tsx";

type ChatHelpers = Parameters<typeof useAISDKRuntime>[0];

/** `useChat()` after a turn failed: the user message, no reply, the thrown Error. */
function failedChat(error: Error): ChatHelpers {
  const noop = async () => {};
  return {
    id: "chat_1",
    messages: [{ id: "msg_user", role: "user", parts: [{ type: "text", text: "Bonjour" }] }],
    status: "error",
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

/** A member: no `billing:manage`, so billing refusals send them to an admin. */
const member: ChatHost = {
  openFile: () => {},
  downloadFile: () => {},
  useFileImageSrc: () => null,
  t: (key) => key,
  can: () => false,
};

function Turn({ chat }: { chat: ChatHelpers }) {
  const runtime = useAISDKRuntime(chat);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Messages
        components={{ UserMessage: () => null, AssistantMessage: MessageError }}
      />
    </AssistantRuntimeProvider>
  );
}

function renderFailedTurn(error: Error): string {
  return renderToString(
    <ChatHostProvider value={member}>
      <Turn chat={failedChat(error)} />
    </ChatHostProvider>,
  );
}

/** The 402 body `usageRejectionResponse` (`src/chat-stream.ts`) answers with. */
const usageRefusal = (code: string) =>
  new Error(
    JSON.stringify({
      type: "https://docs.appstrate.dev/errors/usage-not-allowed",
      title: "Usage not allowed",
      status: 402,
      detail: "English prose for API consumers.",
      code,
    }),
  );

describe("a failed chat turn, through the real assistant-ui runtime", () => {
  it("names an exhausted credit quota", () => {
    const html = renderFailedTurn(usageRefusal("quota_exceeded"));
    expect(html).toContain("turn.error.quotaExceeded turn.error.contactAdmin");
    expect(html).not.toContain("turn.error.unknown");
    expect(html).not.toContain("English prose");
  });

  it("names a blocked subscription", () => {
    const html = renderFailedTurn(usageRefusal("subscription_blocked"));
    expect(html).toContain("turn.error.subscriptionBlocked turn.error.contactAdmin");
    expect(html).not.toContain("turn.error.unknown");
  });

  it("names a dead model credential", () => {
    // The 409 `chat-stream.ts` throws, serialized as the API's error handler does.
    const body = conflict("needs_reconnection", "Credential revoked.").toProblemDetail("req_1");
    const html = renderFailedTurn(new Error(JSON.stringify(body)));
    expect(html).toContain("turn.error.needsReconnection");
    expect(html).not.toContain("turn.error.unknown");
  });

  it("names an in-stream rate limit, and offers a retry", () => {
    const html = renderFailedTurn(new Error("appstrate:chat-turn-error:rate_limited"));
    expect(html).toContain("turn.error.rateLimited");
    expect(html).toContain("turn.retry");
    expect(html).not.toContain("turn.error.unknown");
  });

  it("still degrades an unrecognized failure to the generic sentence", () => {
    // Guards the assertions above: the harness does render the fallback.
    expect(renderFailedTurn(new Error("socket hang up"))).toContain("turn.error.unknown");
  });
});
