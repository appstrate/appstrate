// SPDX-License-Identifier: Apache-2.0

/** The `/` menu's rules: when it opens, what it lists, what a key and a choice do. */

import { describe, expect, it } from "bun:test";
import { MAX_PINNED_SKILLS } from "../src/skills.ts";
import type { ChatCommands } from "../src/commands.ts";
import { slashChoice, slashEntries, slashKey, slashQuery } from "../src/ui/slash-menu.ts";

const commands: ChatCommands = {
  skills: [
    {
      id: "@acme/tone",
      name: "tone",
      description: "Adjusts the Voice of a text",
      version: "1.2.0",
    },
    { id: "@acme/pdf", name: "pdf", description: "Reads PDF files", version: null },
  ],
  agents: [
    { name: "run-report", title: "Weekly report", description: "Builds the report" },
    { name: "run-triage", title: "Inbox triage", description: "Sorts mail" },
  ],
};
const idle = { pinned: [], running: false, canPin: true };
const names = (query: string, ctx = idle) =>
  slashEntries(commands, query, ctx).map((entry) =>
    entry.kind === "skill" ? entry.skill.name : entry.agent.name,
  );

describe("slashQuery", () => {
  it("opens on a draft that is one /token, whose text after the slash filters", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/to")).toBe("to");
    expect(slashQuery("/run-rep")).toBe("run-rep");
  });

  it("is closed once the first token has whitespace, or the draft is not a command", () => {
    expect(slashQuery("/tone ")).toBeNull();
    expect(slashQuery("/tone make it shorter")).toBeNull();
    expect(slashQuery("/tone\nmore")).toBeNull();
    expect(slashQuery("hello /tone")).toBeNull();
    expect(slashQuery(" /tone")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });
});

describe("slashEntries", () => {
  it("lists the skills, then the agents", () => {
    expect(names("")).toEqual(["tone", "pdf", "run-report", "run-triage"]);
  });

  it("filters skills on name or description and agents on name or title, ignoring case", () => {
    expect(names("VOICE")).toEqual(["tone"]);
    expect(names("pdf")).toEqual(["pdf"]);
    expect(names("weekly")).toEqual(["run-report"]);
    expect(names("RUN-T")).toEqual(["run-triage"]);
    // An agent's description is not searched; a skill's is.
    expect(names("sorts")).toEqual([]);
    expect(names("reads")).toEqual(["pdf"]);
  });

  it("has no entry for a query that matches nothing: the menu closes", () => {
    expect(names("zzz")).toEqual([]);
  });

  it("offers no agent while a turn runs, its text being queued as plain text", () => {
    expect(names("", { ...idle, running: true })).toEqual(["tone", "pdf"]);
  });

  it("lists no skill where the selection cannot be changed", () => {
    expect(names("", { ...idle, canPin: false })).toEqual(["run-report", "run-triage"]);
  });

  it("marks a pinned skill, and every unpinned one once the cap is reached", () => {
    const state = (pinned: string[]) =>
      slashEntries(commands, "", { ...idle, pinned }).flatMap((entry) =>
        entry.kind === "skill" ? [entry.state] : [],
      );
    expect(state([])).toEqual(["free", "free"]);
    expect(state(["@acme/pdf"])).toEqual(["free", "pinned"]);
    const full = Array.from({ length: MAX_PINNED_SKILLS - 1 }, (_, i) => `@x/s${i}`);
    expect(state([...full, "@acme/pdf"])).toEqual(["capped", "pinned"]);
  });
});

describe("slashKey", () => {
  it("moves the active entry, wrapping at both ends", () => {
    expect(slashKey("ArrowDown", 0, 3)).toEqual({ active: 1 });
    expect(slashKey("ArrowDown", 2, 3)).toEqual({ active: 0 });
    expect(slashKey("ArrowUp", 1, 3)).toEqual({ active: 0 });
    expect(slashKey("ArrowUp", 0, 3)).toEqual({ active: 2 });
  });

  it("selects on Enter and Tab, closes on Escape", () => {
    expect(slashKey("Enter", 1, 3)).toEqual({ active: 1, action: "select" });
    expect(slashKey("Tab", 1, 3)).toEqual({ active: 1, action: "select" });
    expect(slashKey("Escape", 1, 3)).toEqual({ active: 1, action: "close" });
  });

  it("leaves every other key to the input", () => {
    expect(slashKey("a", 0, 3)).toBeNull();
    expect(slashKey("Backspace", 0, 3)).toBeNull();
  });
});

describe("slashChoice", () => {
  const entry = (name: string) => slashEntries(commands, name, idle)[0]!;

  it("pins a free skill, keeping the order of the others", () => {
    expect(slashChoice(entry("tone"), ["@x/a"])).toEqual({
      kind: "pin",
      pinned: ["@x/a", "@acme/tone"],
    });
  });

  it("only closes on a skill that is already pinned", () => {
    const pinned = slashEntries(commands, "tone", { ...idle, pinned: ["@acme/tone"] })[0]!;
    expect(slashChoice(pinned, ["@acme/tone"])).toEqual({ kind: "close" });
  });

  it("refuses a skill at the cap, without evicting another", () => {
    const full = Array.from({ length: MAX_PINNED_SKILLS }, (_, i) => `@x/s${i}`);
    const capped = slashEntries(commands, "tone", { ...idle, pinned: full })[0]!;
    expect(slashChoice(capped, full)).toEqual({ kind: "refuse" });
  });

  it("chooses an agent as the composer's chip: its name and title only", () => {
    expect(slashChoice(entry("run-report"), [])).toEqual({
      kind: "agent",
      agent: { name: "run-report", title: "Weekly report" },
    });
  });
});
