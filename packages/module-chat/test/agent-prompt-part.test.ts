// SPDX-License-Identifier: Apache-2.0

/** An agent launch carried by a message: how a retry names it, and how a message shows it. */

import { describe, expect, it } from "bun:test";
import {
  agentPromptOf,
  precedingUserMessage,
  retryContent,
  hasBubbleContent,
} from "../src/ui/agent-prompt-part.ts";
import { sendWithDirectives } from "../src/ui/directive-send.ts";

const agent = { name: "run-report", title: "Weekly report" };

describe("what a user message shows of its agent", () => {
  const launch = { name: "run-report", title: "Weekly report", text: "LAUNCH INSTRUCTIONS" };
  const live = {
    content: [
      { type: "text", text: "for Q3" },
      { type: "data", name: "agent-prompt", data: launch },
    ],
  };

  it("reads the title off the runtime message, never the launch text", () => {
    expect(agentPromptOf(live)).toEqual({ name: "run-report", title: "Weekly report" });
    expect(agentPromptOf({ content: [{ type: "text", text: "plain" }] })).toBeNull();
  });

  it("ignores an agent prompt part that is not one", () => {
    expect(
      agentPromptOf({ content: [{ type: "data", name: "agent-prompt", data: { title: 3 } }] }),
    ).toBeNull();
  });

  it("draws the bubble for anything but the agent prompt alone", () => {
    expect(hasBubbleContent(live)).toBe(true);
    expect(
      hasBubbleContent({ content: [{ type: "data", name: "agent-prompt", data: launch }] }),
    ).toBe(false);
    expect(hasBubbleContent({ content: [] })).toBe(false);
  });
});

describe("precedingUserMessage", () => {
  const messages = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant" },
    { id: "u2", role: "user" },
    { id: "a2", role: "assistant" },
  ];

  it("is the nearest user message before the turn: the one a retry must resend", () => {
    expect(precedingUserMessage(messages, "a2")?.id).toBe("u2");
    expect(precedingUserMessage(messages, "a1")?.id).toBe("u1");
  });

  it("is none for an unknown turn or one with nothing before it", () => {
    expect(precedingUserMessage(messages, "zz")).toBeUndefined();
    expect(precedingUserMessage(messages, "u1")).toBeUndefined();
  });
});

describe("retryContent", () => {
  it("is the request alone for a turn that launched no agent", () => {
    expect(retryContent("retry", null)).toEqual([{ type: "text", text: "retry" }]);
  });

  it("leads the request with the directive of the agent the failed turn launched", () => {
    expect(retryContent("retry", agent)).toEqual([
      { type: "text", text: ":agent[Weekly report]{name=run-report} retry" },
    ]);
  });

  it("is sent as the agent prompt part again: the send reads the directive back", () => {
    const [text] = retryContent("retry", agent);
    const message = sendWithDirectives({ role: "user", parts: [text] });
    expect(message.parts.at(-1)).toEqual({ type: "data-agent-prompt", data: agent });
  });
});
