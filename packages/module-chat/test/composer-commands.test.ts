// SPDX-License-Identifier: Apache-2.0

/** The composer's `/` menu: what it lists, how a query ranks it, and when it opens. */

import { describe, expect, it } from "bun:test";
import type { ChatCommands } from "../src/commands.ts";
import { serializeDirective } from "../src/directives.ts";
import { commandList, searchCommands, slashMatch } from "../src/ui/composer-commands.ts";

const commands: ChatCommands = {
  skills: [
    { id: "@acme/tone", name: "tone", description: "Adjusts the tone of a text", version: "1.2.0" },
    { id: "@acme/pdf", name: "pdf", description: "Reads PDF files, tone aside", version: null },
    { id: "@acme/pdf-tools", name: "pdf-tools", description: "More PDF", version: null },
    { id: "@other/tone", name: "tone", description: "Another tone", version: null },
  ],
  agents: [{ name: "run-report", title: "Weekly report", description: "Builds the report" }],
};
const ctx = { pinned: [] as string[], running: false, draft: "" };

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

  it("lists no skill where the selection cannot be changed", () => {
    expect(commandList(commands, { ...ctx, pinned: null }).items.map((i) => i.type)).toEqual([
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

  it("holds back a new skill at the cap, counting the draft's, and says which", () => {
    const draft = serializeDirective({ type: "skill", label: "tone", id: "@other/tone" });
    const list = commandList(commands, {
      ...ctx,
      pinned: ["@x/1", "@x/2", "@x/3", "@acme/tone"],
      draft,
    });
    // Pinned or already in the draft: still offered, marked added. Any other is capped.
    expect(list.items.filter((i) => i.type === "skill").map((i) => i.id)).toEqual([
      "@acme/tone",
      "@other/tone",
    ]);
    expect(list.items.find((i) => i.id === "@acme/tone")?.metadata?.added).toBe(true);
    expect(list.capped.map((i) => i.id)).toEqual(["@acme/pdf", "@acme/pdf-tools"]);
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
