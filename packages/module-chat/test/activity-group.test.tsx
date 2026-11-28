// SPDX-License-Identifier: Apache-2.0

/**
 * An activity group's shape over a turn: what it keeps in view whatever its fold (the breakout: a
 * connect card, a launched run) holds one place in the tree from the first chunk to the settled
 * turn, so it never remounts. The group renders as a function inside the real assistant-ui runtime,
 * and the element tree it returns is inspected.
 */

import { describe, expect, it } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { AssistantRuntimeProvider, ThreadPrimitive } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { Collapsible } from "@appstrate/ui/components/collapsible";

import { ChatHostProvider } from "../src/ui/runtime-context.ts";
import { ActivityGroup } from "../src/ui/activity-group.tsx";
import { ActivityModeContext, type ActivityMode } from "../src/ui/activity-mode.ts";
import { ThinkingStatus } from "../src/ui/reasoning.tsx";
import { ThreadCallLine } from "../src/ui/tool-uis.tsx";
import { testHost } from "./test-host.ts";

type ChatHelpers = Parameters<typeof useAISDKRuntime>[0];
type Parts = ChatHelpers["messages"][number]["parts"];

function chat(parts: Parts, status: ChatHelpers["status"]): ChatHelpers {
  const noop = async () => {};
  return {
    id: "chat_1",
    messages: [
      { id: "msg_user", role: "user", parts: [{ type: "text", text: "Bonjour" }] },
      { id: "msg_assistant", role: "assistant", parts },
    ],
    status,
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

const lookup = (id: string, done: boolean) =>
  ({
    type: "dynamic-tool",
    toolName: "search",
    toolCallId: id,
    input: { query: id },
    ...(done
      ? { state: "output-available", output: { results: [] } }
      : { state: "input-available" }),
  }) as const;

const answer = { type: "text", text: "Voilà.", state: "done" } as const;

/** What the group keeps in view: the same element in every render. */
const BREAKOUT = <i data-breakout />;

/** The element tree `ActivityGroup` returns for the group of `indices`. */
function groupTree(
  parts: Parts,
  status: ChatHelpers["status"],
  indices: number[],
): ReactElement<{ children: ReactNode[] }> {
  let tree: ReactNode = null;
  function Probe() {
    tree = ActivityGroup({ indices, stored: new Map(), children: BREAKOUT });
    return null;
  }
  function Turn() {
    const runtime = useAISDKRuntime(chat(parts, status));
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Messages
          components={{ UserMessage: () => null, AssistantMessage: Probe }}
        />
      </AssistantRuntimeProvider>
    );
  }
  renderToString(
    <ChatHostProvider value={testHost()}>
      <Turn />
    </ChatHostProvider>,
  );
  if (!isValidElement<{ children: ReactNode[] }>(tree)) throw new Error("no group rendered");
  return tree;
}

/** The root's two children: the line, then the breakout. */
function slots(tree: ReactElement<{ children: ReactNode[] }>) {
  const [line, breakout] = tree.props.children as [
    ReactElement<{ lead?: ReactNode }>,
    ReactElement<{ value: ActivityMode; children: ReactNode }>,
  ];
  return { line, breakout };
}

describe("an activity group's tree over a turn", () => {
  const running = groupTree([lookup("s1", false)], "streaming", [0]);
  const settled = groupTree([lookup("s1", true), answer], "ready", [0]);
  const joined = groupTree([lookup("s1", true), lookup("s2", false)], "streaming", [0, 1]);

  it("keeps one root and the breakout in one place, from the first chunk to the settled turn", () => {
    for (const tree of [running, settled, joined]) {
      expect(tree.type).toBe("div");
      expect(tree.props.children).toHaveLength(2);
      const { breakout } = slots(tree);
      expect(breakout.type).toBe(ActivityModeContext);
      expect(breakout.props.value.mode).toBe("breakout");
      expect(breakout.props.children).toBe(BREAKOUT);
    }
  });

  it("draws a lone call as its own line for its whole life, the spark leading while it runs", () => {
    const live = slots(running).line;
    const done = slots(settled).line;
    expect(live.type).toBe(ThreadCallLine);
    expect(done.type).toBe(ThreadCallLine);
    expect(isValidElement(live.props.lead) && live.props.lead.type).toBe(ThinkingStatus);
    expect(isValidElement(done.props.lead) && done.props.lead.type).not.toBe(ThinkingStatus);
  });

  it("becomes the disclosure when a second step joins, the breakout still in its place", () => {
    expect(slots(joined).line.type).toBe(Collapsible);
  });
});
