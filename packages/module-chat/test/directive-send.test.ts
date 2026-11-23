// SPDX-License-Identifier: Apache-2.0

/** What a send does with the skills and the agent a message names. */

import { describe, expect, it } from "bun:test";
import { serializeDirective } from "../src/directives.ts";
import { citedSkillIds, effectiveSkills } from "../src/ui/chat-skills.ts";
import { draftIssue, namesAgent, sendWithDirectives } from "../src/ui/directive-send.ts";

const skill = (name: string) =>
  serializeDirective({ type: "skill", label: name, id: `@acme/${name}` });
const agent = (title: string, name = "run-report") =>
  serializeDirective({ type: "agent", label: title, id: name });
const user = (...parts: object[]) => ({ role: "user", parts });

describe("sendWithDirectives", () => {
  it("collects the skills a message names, once each, and leaves the message as it is", () => {
    const message = user({
      type: "text",
      text: `${skill("tone")} and ${skill("pdf")} ${skill("tone")}`,
    });
    const sent = sendWithDirectives(message);
    expect(sent.skills).toEqual(["@acme/tone", "@acme/pdf"]);
    expect(sent.message).toBe(message);
  });

  it("turns the agent directive into the agent prompt part, text kept as typed", () => {
    const text = `${agent("Weekly report")} for Q3`;
    const message = user({ type: "text", text }, { type: "file", url: "appfile://f1" });
    const sent = sendWithDirectives(message);
    expect(sent.message.parts).toEqual([
      { type: "text", text },
      { type: "file", url: "appfile://f1" },
      { type: "data-agent-prompt", data: { name: "run-report", title: "Weekly report" } },
    ]);
    expect(message.parts).toHaveLength(2);
  });

  it("sends a message with only an agent chip as an ordinary, non-empty text message", () => {
    const sent = sendWithDirectives(user({ type: "text", text: agent("Weekly report") }));
    expect(sent.message.parts).toHaveLength(2);
    expect((sent.message.parts[0] as { text: string }).text).not.toBe("");
  });

  it("keeps only the first agent when it is handed two (the composer refuses to send them)", () => {
    const sent = sendWithDirectives(
      user({ type: "text", text: `${agent("A", "run-a")} ${agent("B", "run-b")}` }),
    );
    expect(
      sent.message.parts.filter((p) => (p as { type: string }).type === "data-agent-prompt"),
    ).toEqual([{ type: "data-agent-prompt", data: { name: "run-a", title: "A" } }]);
  });

  it("adds no second part to a message that carries its launch already", () => {
    const message = user(
      { type: "text", text: agent("Weekly report") },
      { type: "data-agent-prompt", data: { name: "run-report", title: "Weekly report" } },
    );
    expect(sendWithDirectives(message).message).toBe(message);
  });

  it("cuts a title past the part's limit", () => {
    const sent = sendWithDirectives(user({ type: "text", text: agent("t".repeat(300)) }));
    const part = sent.message.parts.at(-1) as { data: { title: string } };
    expect(part.data.title).toHaveLength(200);
  });

  it("passes through what has no parts", () => {
    expect(sendWithDirectives(undefined)).toEqual({ message: undefined, skills: [] });
    const text = { text: "hello" };
    expect(sendWithDirectives(text).message).toBe(text);
  });
});

describe("draftIssue", () => {
  /** As the composer counts it: the draft's cited skills over the pinned ones. */
  const issue = (text: string, pinned: readonly string[]) =>
    draftIssue(text, effectiveSkills(pinned, citedSkillIds(text)).overCap);

  it("is none for a draft naming one agent and skills within the cap", () => {
    expect(issue(`${agent("A")} ${skill("tone")}`, ["@acme/pdf"])).toBeNull();
  });

  it("refuses a second agent", () => {
    expect(issue(`${agent("A", "run-a")} ${agent("B", "run-b")}`, [])).toBe("agents");
    // The same agent twice is two launches too.
    expect(issue(`${agent("A")} ${agent("A")}`, [])).toBe("agents");
  });

  it("refuses skills past the cap, counting the pinned ones, not those already pinned", () => {
    const pinned = ["@acme/a", "@acme/b", "@acme/c", "@acme/d"];
    expect(issue(`${skill("e")}`, pinned)).toBeNull();
    expect(issue(`${skill("e")} ${skill("f")}`, pinned)).toBe("pins");
    expect(issue(`${skill("a")} ${skill("b")}`, pinned)).toBeNull();
  });
});

describe("namesAgent", () => {
  it("tells an agent directive from a skill and from plain text", () => {
    expect(namesAgent(agent("A"))).toBe(true);
    expect(namesAgent(skill("tone"))).toBe(false);
    expect(namesAgent("/run-report")).toBe(false);
  });
});
