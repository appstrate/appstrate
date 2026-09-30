// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #1582, end to end: a failed turn renders ITS sentence through the real
 * assistant-ui runtime, not the generic failure.
 *
 * `turn-error-state.test.ts` feeds `turnErrorState` a hand-built
 * `{ code, message }`; here the error goes in as the AI SDK throws it and
 * everything after is real. A refusal is the transport's `APICallError` (body as
 * `message`); an in-stream failure is `new Error(errorText)` from the `error`
 * chunk. `useAISDKRuntime` normalizes either with its private `toChatError`
 * (`code: "AI_APICallError"` for the first, `"unknown"` for the second), and
 * `completeExternalMessageConversion` (`@assistant-ui/core`) appends an
 * assistant message with `status.reason: "error"` after the last user message.
 * Both run during render, so SSR is enough.
 */

import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { AssistantRuntimeProvider, ThreadPrimitive } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { APICallError } from "ai";
import { conflict } from "@appstrate/core/api-errors";

import { ChatHostProvider, type ChatHost } from "../src/ui/runtime-context.ts";
import { MessageError } from "../src/ui/thread.tsx";
import { chatCapacityError } from "../src/pi-chat/concurrency.ts";

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

/** Holds `billing:manage`: billing refusals link to the billing page instead. */
const billingManager: ChatHost = { ...member, can: (p) => p === "billing:manage" };

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

function renderFailedTurn(error: Error, host: ChatHost = member): string {
  return renderToString(
    <ChatHostProvider value={host}>
      <Turn chat={failedChat(error)} />
    </ChatHostProvider>,
  );
}

/** A refused request, as `createUIApiCallError` (`ai`) throws it. */
function refused<P extends { status: number }>(problem: P): APICallError {
  const responseBody = JSON.stringify(problem);
  return new APICallError({
    message: responseBody,
    url: "/api/chat",
    requestBodyValues: undefined,
    statusCode: problem.status,
    responseBody,
  });
}

/** The 402 body `usageRejectionResponse` (`src/chat-stream.ts`) answers with. */
const usageRefusal = (code: string) =>
  refused({
    type: "https://docs.appstrate.dev/errors/usage-not-allowed",
    title: "Usage not allowed",
    status: 402,
    detail: "English prose for API consumers.",
    code,
  });

describe("a failed chat turn, through the real assistant-ui runtime", () => {
  it("names an exhausted credit quota, with no retry", () => {
    const html = renderFailedTurn(usageRefusal("quota_exceeded"));
    expect(html).toContain("turn.error.quotaExceeded turn.error.contactAdmin");
    expect(html).not.toContain("turn.error.unknown");
    expect(html).not.toContain("English prose");
    expect(html).not.toContain("turn.retry");
  });

  it("links a billing manager to the billing page", () => {
    const html = renderFailedTurn(usageRefusal("quota_exceeded"), billingManager);
    expect(html).toContain('href="/org-settings/billing"');
    expect(html).toContain("turn.error.manageBilling");
    expect(html).not.toContain("turn.error.contactAdmin");
  });

  it("names a dead model credential, with no retry", () => {
    // The 409 `chat-stream.ts` throws, serialized as the API's error handler does.
    const body = conflict("needs_reconnection", "Credential revoked.").toProblemDetail("req_1");
    const html = renderFailedTurn(refused(body));
    expect(html).toContain("turn.error.needsReconnection");
    expect(html).not.toContain("turn.error.unknown");
    expect(html).not.toContain("turn.retry");
  });

  it("names a pre-stream 429 as rate limiting, and offers a retry", () => {
    // The capacity cap, serialized as the API's error handler does.
    const html = renderFailedTurn(refused(chatCapacityError().toProblemDetail("req_1")));
    expect(html).toContain("turn.error.rateLimited");
    expect(html).toContain("turn.retry");
    expect(html).not.toContain("turn.error.unknown");
  });

  it("names an in-stream rate limit, and offers a retry", () => {
    // What `processUIMessageStream` (`ai`) raises for an `error` chunk.
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
