// SPDX-License-Identifier: Apache-2.0

/** The directive syntax the composer writes, read the same way by the browser and the server. */

import { describe, expect, it } from "bun:test";
import {
  directiveSegments,
  directivesOf,
  readableDirectives,
  serializeDirective,
} from "../src/directives.ts";

const skill = { type: "skill", label: "tone", id: "@acme/tone" } as const;
const agent = { type: "agent", label: "Weekly report", id: "run-report" } as const;

describe("directives", () => {
  it("round-trips a skill and an agent through the text", () => {
    const text = `use ${serializeDirective(skill)} then ${serializeDirective(agent)}!`;
    expect(serializeDirective(skill)).toBe(":skill[tone]{name=@acme/tone}");
    expect(directivesOf(text)).toMatchObject([skill, agent]);
  });

  it("keeps a label with brackets, quotes or spaces whole", () => {
    const odd = { type: "agent", label: 'Rapport [Q3] "final"', id: "run-q3" } as const;
    expect(directivesOf(serializeDirective(odd))).toMatchObject([odd]);
  });

  it("splits the text into literal text and directives, in order", () => {
    expect(directiveSegments(`a ${serializeDirective(skill)} b`)).toEqual([
      { kind: "text", text: "a " },
      { kind: "directive", ...skill },
      { kind: "text", text: " b" },
    ]);
  });

  it("leaves any other :type[label] as the text it is", () => {
    expect(directiveSegments("see :smile[x]{name=y} now")).toEqual([
      { kind: "text", text: "see :smile[x]{name=y} now" },
    ]);
    expect(directivesOf("see :smile[x]")).toEqual([]);
  });
});

describe("readableDirectives", () => {
  it("reads each directive as /label", () => {
    expect(
      readableDirectives(`${serializeDirective(agent)} for ${serializeDirective(skill)}`),
    ).toBe("/Weekly report for /tone");
  });

  it("drops the agent, and only the agent, when asked: it is no part of its own request", () => {
    expect(
      readableDirectives(`${serializeDirective(agent)} for ${serializeDirective(skill)}`, {
        omitAgent: true,
      }),
    ).toBe(" for /tone");
  });

  it("is the text itself when it names nothing", () => {
    expect(readableDirectives("plain /path text")).toBe("plain /path text");
  });
});

it("preserves fenced, inline and escaped directives while recognizing the selected prose chip", () => {
  const chip = ":skill[tone]{name=@acme/tone}";
  const examples = [
    `\`\`${chip}\`\``,
    "~".repeat(4) + "\n" + chip + "\n~~~~",
    "\\" + chip,
    "    " + chip,
  ];
  for (const example of examples) {
    const text = example + "\n\n" + chip;
    expect(directivesOf(text)).toHaveLength(1);
    expect(readableDirectives(text)).toBe(example + "\n\n/tone");
  }
});
