// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { AssistantRuntimeProvider, ThreadPrimitive } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationScopeProvider } from "../src/ui/conversation-scope.ts";
import { TurnSpaceChoice } from "../src/ui/space-choice.tsx";
import { ChatHostProvider, type ChatHost } from "../src/ui/runtime-context.ts";
import { testHost } from "./test-host.ts";

function PendingTurn() {
  const noop = async () => {};
  const runtime = useAISDKRuntime({
    id: "chat",
    messages: [
      {
        id: "question",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "pending",
            toolName: "invoke_operation",
            state: "output-available",
            input: { operation_id: "listAgents" },
            output: {
              spaceChoice: {
                tool: "invoke_operation",
                operationId: "listAgents",
                spaceIds: ["team"],
              },
            },
          },
        ],
      },
    ],
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
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Messages components={{ AssistantMessage: TurnSpaceChoice }} />
    </AssistantRuntimeProvider>
  );
}

it("renders the saved question against current access when a user reopens the conversation", () => {
  function render(
    actingSpaceIds: ChatHost["actingSpaceIds"],
    canReply: boolean,
    restricted = false,
  ) {
    const host = testHost({
      actingSpaceIds,
      can: () => canReply,
      canIn: (space) => space === "other" && canReply,
      useSpaceLabelOf: () => () => "Team name",
    });
    return renderToStaticMarkup(
      <ChatHostProvider value={host}>
        <ConversationScopeProvider
          value={{
            restricted,
            originSpaceId: restricted ? "team" : null,
            generating: false,
            pending: false,
            limitTo: () => {},
            lift: () => {},
          }}
        >
          <PendingTurn />
        </ConversationScopeProvider>
      </ChatHostProvider>,
    );
  }
  expect(render(["team", "other"], true)).toContain("Team name");
  const revoked = render(["other"], true);
  expect(revoked).not.toContain("<button");
  expect(revoked).toContain("tool.spaceChoiceUnavailable");
  expect(revoked).toContain("tool.spaceChoiceRetry");
  const limited = render(["team", "other"], true, true);
  expect(limited).toContain("tool.spaceChoiceUnavailable");
  expect(limited).not.toContain("tool.spaceChoiceRetry");
  expect(limited).not.toContain("<button");
  const readOnly = render([], false);
  expect(readOnly).toContain("tool.spaceChoiceUnavailable");
  expect(readOnly).not.toContain("tool.spaceChoiceRetry");
  expect(render(null, false)).not.toContain("tool.spaceChoiceUnavailable");
});
