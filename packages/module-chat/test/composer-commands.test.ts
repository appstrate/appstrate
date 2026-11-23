// SPDX-License-Identifier: Apache-2.0

/** The composer's `/` menu: what it lists, how a query ranks it, and when it opens. */

import { describe, expect, it } from "bun:test";
import type { ChatCommands } from "../src/commands.ts";
import { serializeDirective } from "../src/directives.ts";
import {
  commandList,
  noCommandMatch,
  searchCommands,
  slashMatch,
} from "../src/ui/composer-commands.ts";
import { CHAT_SKILLS_CONTENT_BUDGET_CHARS } from "../src/skills.ts";
import { citedSkillIds, effectiveSkills, type StoredSkills } from "../src/ui/chat-skills.ts";

const commands: ChatCommands = {
  skills: [
    {
      id: "@acme/tone",
      name: "tone",
      description: "Adjusts the tone of a text",
      version: "1.2.0",
      bytes: 1_000,
    },
    {
      id: "@acme/pdf",
      name: "pdf",
      description: "Reads PDF files, tone aside",
      version: null,
      bytes: 2_000,
    },
    {
      id: "@acme/pdf-tools",
      name: "pdf-tools",
      description: "More PDF",
      version: null,
      bytes: 3_000,
    },
    { id: "@other/tone", name: "tone", description: "Another tone", version: null, bytes: null },
  ],
  agents: [
    {
      name: "run-report",
      title: "Weekly report",
      description: "Builds the report",
      packageId: "@acme/report",
      icon: "lucide:chart-bar",
      color: "blue",
    },
  ],
};
/** The menu's context over `pinned` (loaded at `chars` each) and the skills `draft` cites. */
const skillsOf = (pinned: string[], draft = "", chars = 0) => {
  const stored: StoredSkills = {
    skillDiscovery: true,
    pins: pinned.map((id) => ({ id, status: "injected", chars })),
  };
  return { stored, effective: effectiveSkills(pinned, citedSkillIds(draft)) };
};
/** Pins loaded at sizes leaving `room` characters of the budget. */
const leaving = (room: number, draft = "") =>
  skillsOf(["@acme/tone"], draft, CHAT_SKILLS_CONTENT_BUDGET_CHARS - room);
const ctx = { skills: skillsOf([]), running: false, draft: "" };

describe("commandList", () => {
  it("lists skills by name then agents by title, ids being the package id and the prompt name", () => {
    const { items } = commandList(commands, ctx);
    expect(items.map((i) => `${i.type}:${i.label}:${i.id}`)).toEqual([
      "skill:tone:@acme/tone",
      "skill:pdf:@acme/pdf",
      "skill:pdf-tools:@acme/pdf-tools",
      "skill:tone:@other/tone",
      "agent:Weekly report:run-report",
    ]);
  });

  it("carries the agent's appearance for its row's tile, and none for a skill", () => {
    const { items } = commandList(commands, ctx);
    expect(items.find((i) => i.type === "agent")?.metadata?.appearance).toEqual({
      packageId: "@acme/report",
      icon: "lucide:chart-bar",
      color: "blue",
    });
    expect(items.find((i) => i.type === "skill")?.metadata?.appearance).toBeUndefined();
  });

  it("lists no skill where the selection cannot be changed", () => {
    expect(commandList(commands, { ...ctx, skills: null }).items.map((i) => i.type)).toEqual([
      "agent",
    ]);
  });

  it("offers no agent while a turn runs", () => {
    expect(
      commandList(commands, { ...ctx, running: true }).items.some((i) => i.type === "agent"),
    ).toBe(false);
  });

  it("offers no second agent once the draft names one", () => {
    const draft = serializeDirective({ type: "agent", label: "Weekly report", id: "run-report" });
    expect(commandList(commands, { ...ctx, draft }).items.some((i) => i.type === "agent")).toBe(
      false,
    );
  });

  it("holds back a new skill whose size would pass the budget, and says which", () => {
    const draft = serializeDirective({ type: "skill", label: "tone", id: "@other/tone" });
    const list = commandList(commands, { ...ctx, skills: leaving(2_500, draft), draft });
    // Pinned or cited: offered, marked as such. A size that fits, or an unknown one, is offered.
    expect(list.items.filter((i) => i.type === "skill").map((i) => i.id)).toEqual([
      "@acme/tone",
      "@acme/pdf",
      "@other/tone",
    ]);
    const meta = (id: string) => list.items.find((i) => i.id === id)?.metadata;
    expect(meta("@acme/tone")).toMatchObject({ pinned: true, cited: false });
    // Only cited in the draft: never « already pinned ».
    expect(meta("@other/tone")).toMatchObject({ pinned: false, cited: true });
    expect(list.overBudget.map((i) => i.id)).toEqual(["@acme/pdf-tools"]);
  });

  it("counts the draft's cited skills against the budget", () => {
    const draft = serializeDirective({ type: "skill", label: "pdf", id: "@acme/pdf" });
    const list = commandList(commands, { ...ctx, skills: leaving(4_000, draft), draft });
    // 2 000 of the 4 000 left go to the cited pdf: pdf-tools' 3 000 no longer fit.
    expect(list.overBudget.map((i) => i.id)).toEqual(["@acme/pdf-tools"]);
    expect(commandList(commands, { ...ctx, skills: leaving(4_000) }).overBudget).toEqual([]);
  });
});

describe("searchCommands", () => {
  const { items } = commandList(commands, ctx);
  const ids = (query: string) => searchCommands(items, query).map((i) => i.id);

  it("ranks the exact name, then the prefix, then the substring, then the description", () => {
    expect(ids("pdf")).toEqual(["@acme/pdf", "@acme/pdf-tools"]);
    expect(ids("tone")).toEqual(["@acme/tone", "@other/tone", "@acme/pdf"]);
  });

  it("is case-insensitive and lists everything for an empty query, skills first", () => {
    expect(ids("TON")).toEqual(["@acme/tone", "@other/tone", "@acme/pdf"]);
    expect(ids("")).toHaveLength(5);
    expect(ids("")[4]).toBe("run-report");
  });

  it("finds an agent by its title or by its prompt name", () => {
    expect(ids("weekly")).toEqual(["run-report"]);
    expect(ids("run-rep")).toEqual(["run-report"]);
  });

  it("matches nothing for an unknown name", () => {
    expect(ids("zzz")).toEqual([]);
  });
});

describe("noCommandMatch", () => {
  it("keeps the menu open for a skill held back by the budget, so the menu says why", () => {
    const list = commandList(commands, { ...ctx, skills: leaving(1_500), running: true });
    // Nothing offered matches `pdf`: both pdf skills would pass the budget.
    expect(searchCommands(list.items, "pdf")).toEqual([]);
    expect(searchCommands(list.overBudget, "pdf").map((i) => i.id)).toEqual([
      "@acme/pdf",
      "@acme/pdf-tools",
    ]);
    expect(noCommandMatch(list, "pdf")).toBe(false);
    expect(slashMatch("/pdf", 4, (q) => noCommandMatch(list, q))?.query).toBe("pdf");
  });

  it("closes when neither an entry nor an over-budget skill matches, and stays open while loading", () => {
    const list = commandList(commands, ctx);
    expect(noCommandMatch(list, "usr")).toBe(true);
    expect(noCommandMatch(list, "tone")).toBe(false);
    expect(noCommandMatch(null, "usr")).toBe(false);
  });
});

describe("slashMatch", () => {
  const open = () => false;

  it("opens on a / that starts a word, up to the cursor", () => {
    expect(slashMatch("/to", 3, open)).toEqual({ query: "to", offset: 0, endOffset: 3 });
    expect(slashMatch("use /to", 7, open)).toEqual({ query: "to", offset: 4, endOffset: 7 });
    expect(slashMatch("a\n/", 3, open)).toEqual({ query: "", offset: 2, endOffset: 3 });
  });

  it("does not open inside a word, after a space, or for a cursor before the /", () => {
    expect(slashMatch("a/b", 3, open)).toBeNull();
    expect(slashMatch("/to ", 4, open)).toBeNull();
    expect(slashMatch("hello /to", 3, open)).toBeNull();
  });

  it("does not open when nothing matches: Enter then sends the text", () => {
    expect(slashMatch("/usr", 4, (q) => q === "usr")).toBeNull();
  });
});
