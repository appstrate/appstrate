// SPDX-License-Identifier: Apache-2.0

/** What a send does with the agent a message names; its skills stay in the text. */

import { describe, expect, it } from "bun:test";
import { serializeDirective } from "../src/directives.ts";
import { namesAgent, namesSeveralAgents, sendWithDirectives } from "../src/ui/directive-send.ts";

const skill = (name: string) =>
  serializeDirective({ type: "skill", label: name, id: `@acme/${name}` });
const agent = (title: string, name = "run-report") =>
  serializeDirective({ type: "agent", label: title, id: name });
const user = (...parts: object[]) => ({ role: "user", parts });

describe("sendWithDirectives", () => {
  it("leaves a message naming skills as it is", () => {
    const message = user({ type: "text", text: `${skill("tone")} and ${skill("pdf")}` });
    expect(sendWithDirectives(message)).toBe(message);
  });

  it("turns the agent directive into the agent prompt part, text kept as typed", () => {
    const text = `${agent("Weekly report")} for Q3`;
    const message = user({ type: "text", text }, { type: "file", url: "appfile://f1" });
    const sent = sendWithDirectives(message);
    expect(sent.parts).toEqual([
      { type: "text", text },
      { type: "file", url: "appfile://f1" },
      { type: "data-agent-prompt", data: { name: "run-report", title: "Weekly report" } },
    ]);
    expect(message.parts).toHaveLength(2);
  });

  it("launches the selected agent with Markdown inside its title and leaves the code example alone", () => {
    const title = "Review `package.json` [Q3] <code>v2</code>";
    const example = "`" + agent("Example", "run-example") + "`";
    const text = `${example} then ${agent(title)}`;
    expect(sendWithDirectives(user({ type: "text", text })).parts).toEqual([
      { type: "text", text },
      { type: "data-agent-prompt", data: { name: "run-report", title } },
    ]);
    const bracketTitle = "Review `package.json`";
    expect(namesAgent(agent(bracketTitle))).toBe(true);
  });

  it("sends a message with only an agent chip as an ordinary, non-empty text message", () => {
    const sent = sendWithDirectives(user({ type: "text", text: agent("Weekly report") }));
    expect(sent.parts).toHaveLength(2);
    expect((sent.parts[0] as { text: string }).text).not.toBe("");
  });

  it("keeps only the first agent when it is handed two (the composer refuses to send them)", () => {
    const sent = sendWithDirectives(
      user({ type: "text", text: `${agent("A", "run-a")} ${agent("B", "run-b")}` }),
    );
    expect(sent.parts.filter((p) => (p as { type: string }).type === "data-agent-prompt")).toEqual([
      { type: "data-agent-prompt", data: { name: "run-a", title: "A" } },
    ]);
  });

  it("adds no second part to a message that carries its launch already", () => {
    const message = user(
      { type: "text", text: agent("Weekly report") },
      { type: "data-agent-prompt", data: { name: "run-report", title: "Weekly report" } },
    );
    expect(sendWithDirectives(message)).toBe(message);
  });

  it("cuts a title past the part's limit", () => {
    const sent = sendWithDirectives(user({ type: "text", text: agent("t".repeat(300)) }));
    const part = sent.parts.at(-1) as { data: { title: string } };
    expect(part.data.title).toHaveLength(200);
  });

  it("passes through what has no parts", () => {
    expect(sendWithDirectives(undefined)).toBeUndefined();
    const text = { text: "hello" };
    expect(sendWithDirectives(text)).toBe(text);
  });
});

describe("namesSeveralAgents", () => {
  it("is none for a draft naming one agent", () => {
    expect(namesSeveralAgents(`${agent("A")} ${skill("tone")}`)).toBe(false);
  });

  it("refuses a second agent", () => {
    expect(namesSeveralAgents(`${agent("A", "run-a")} ${agent("B", "run-b")}`)).toBe(true);
    // The same agent twice is two launches too.
    expect(namesSeveralAgents(`${agent("A")} ${agent("A")}`)).toBe(true);
  });

  it("never refuses a draft for its skills, however many it names", () => {
    const many = ["a", "b", "c", "d", "e", "f", "g"].map(skill).join(" ");
    expect(namesSeveralAgents(many)).toBe(false);
  });
});

describe("namesAgent", () => {
  it("tells an agent directive from a skill and from plain text", () => {
    expect(namesAgent(agent("A"))).toBe(true);
    expect(namesAgent(skill("tone"))).toBe(false);
    expect(namesAgent("/run-report")).toBe(false);
  });
});
