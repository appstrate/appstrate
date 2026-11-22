// SPDX-License-Identifier: Apache-2.0

/** An agent launch from the composer: how it rides on a send, and how a message shows it. */

import { describe, expect, it } from "bun:test";
import {
  agentOfRunConfig,
  agentOnlyContent,
  agentPromptOf,
  precedingUserMessage,
  retryContent,
  agentRunConfig,
  hasBubbleContent,
  messageWithAgentPrompt,
} from "../src/ui/agent-prompt-part.ts";

const agent = { name: "run-report", title: "Weekly report" };

describe("the composer's run config", () => {
  it("round-trips the chosen agent, and is empty when none is chosen", () => {
    expect(agentOfRunConfig(agentRunConfig(agent))).toEqual(agent);
    expect(agentRunConfig(null)).toEqual({});
    expect(agentOfRunConfig({})).toBeNull();
    expect(agentOfRunConfig(undefined)).toBeNull();
  });

  it("reads nothing out of a malformed config", () => {
    expect(agentOfRunConfig({ custom: { agentPrompt: { name: "x" } } })).toBeNull();
    expect(agentOfRunConfig({ custom: { agentPrompt: "run-report" } })).toBeNull();
  });
});

describe("messageWithAgentPrompt", () => {
  const message = {
    role: "user",
    parts: [
      { type: "text", text: "for Q3" },
      { type: "file", url: "appfile://f1", mediaType: "text/csv" },
    ],
  };

  it("adds the agent prompt part, name and title, to the text and file parts", () => {
    expect(messageWithAgentPrompt(message, agentRunConfig(agent))).toEqual({
      role: "user",
      parts: [
        { type: "text", text: "for Q3" },
        { type: "file", url: "appfile://f1", mediaType: "text/csv" },
        { type: "data-agent-prompt", data: agent },
      ],
    });
    expect(message.parts).toHaveLength(2);
  });

  it("sends a message without an agent as it is", () => {
    expect(messageWithAgentPrompt(message, {})).toBe(message);
    expect(messageWithAgentPrompt(message, undefined)).toBe(message);
    expect(messageWithAgentPrompt(undefined, agentRunConfig(agent))).toBeUndefined();
  });

  it("leaves a message that carries no parts as it is", () => {
    const textOnly = { text: "hello" };
    expect(messageWithAgentPrompt(textOnly, agentRunConfig(agent))).toBe(textOnly);
  });
});

describe("agentOnlyContent", () => {
  it("is one native data part, which the runtime sends as data-agent-prompt", () => {
    expect(agentOnlyContent(agent)).toEqual([{ type: "data", name: "agent-prompt", data: agent }]);
  });
});

describe("what a user message shows of its agent", () => {
  const launch = { name: "run-report", title: "Weekly report", text: "LAUNCH INSTRUCTIONS" };
  const stored = {
    parts: [
      { type: "text", text: "for Q3" },
      { type: "data-agent-prompt", data: launch },
    ],
  };
  const live = {
    content: [
      { type: "text", text: "for Q3" },
      { type: "data", name: "agent-prompt", data: launch },
    ],
  };

  it("reads the title off a stored message and off the runtime's, never the launch text", () => {
    expect(agentPromptOf(stored)).toEqual({ name: "run-report", title: "Weekly report" });
    expect(agentPromptOf(live)).toEqual({ name: "run-report", title: "Weekly report" });
    expect(agentPromptOf({ parts: [{ type: "text", text: "plain" }] })).toBeNull();
    expect(agentPromptOf({})).toBeNull();
  });

  it("ignores an agent prompt part that is not one", () => {
    expect(
      agentPromptOf({ parts: [{ type: "data-agent-prompt", data: { title: 3 } }] }),
    ).toBeNull();
  });

  it("draws the bubble for anything but the agent prompt alone", () => {
    expect(hasBubbleContent(stored)).toBe(true);
    expect(hasBubbleContent(live)).toBe(true);
    expect(hasBubbleContent({ parts: [{ type: "data-agent-prompt", data: launch }] })).toBe(false);
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

  it("names the agent the failed turn launched, as a native data part", () => {
    expect(retryContent("retry", agent)).toEqual([
      { type: "text", text: "retry" },
      { type: "data", name: "agent-prompt", data: agent },
    ]);
  });
});
