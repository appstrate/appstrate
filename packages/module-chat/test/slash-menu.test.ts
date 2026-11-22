// SPDX-License-Identifier: Apache-2.0

/** The `/` menu's rules: when it opens, what it lists, what a key and a choice do. */

import { describe, expect, it } from "bun:test";
import { MAX_PINNED_SKILLS } from "../src/skills.ts";
import type { ChatCommands } from "../src/commands.ts";
import {
  dismissalFor,
  isComposingKey,
  parseTypedCommand,
  slashChoice,
  slashEntries,
  slashKey,
  slashQuery,
  typedSendPlan,
} from "../src/ui/slash-menu.ts";

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

describe("ranking", () => {
  const collision: ChatCommands = {
    skills: [
      { id: "@a/reader", name: "reader", description: "Opens a pdf and reads it", version: null },
      { id: "@a/pdf-tools", name: "pdf-tools", description: "Tools", version: null },
      { id: "@a/my-pdf", name: "my-pdf", description: "Mine", version: null },
      { id: "@a/pdf", name: "pdf", description: "Reads PDF files", version: null },
    ],
    agents: [],
  };
  const order = (query: string) =>
    slashEntries(collision, query, idle).map((e) => (e.kind === "skill" ? e.skill.name : ""));

  it("puts the exact name first, then name prefix, name substring, then description", () => {
    expect(order("pdf")).toEqual(["pdf", "pdf-tools", "my-pdf", "reader"]);
  });

  it("makes /pdf pick the skill named pdf: it is the first entry Enter takes", () => {
    expect(order("pdf")[0]).toBe("pdf");
  });

  it("ranks agents by name, then title", () => {
    const agents: ChatCommands = {
      skills: [],
      agents: [
        { name: "run-other", title: "Report builder", description: "" },
        { name: "run-report", title: "Weekly", description: "" },
      ],
    };
    expect(
      slashEntries(agents, "report", idle).map((e) => e.kind === "agent" && e.agent.name),
    ).toEqual(["run-report", "run-other"]);
  });
});

describe("parseTypedCommand", () => {
  const parse = (text: string, ctx = idle) => parseTypedCommand(text, commands, ctx);

  it("takes a skill named exactly, and the rest of the draft as the message", () => {
    const typed = parse("/tone make it shorter")!;
    expect(typed.entry.kind === "skill" && typed.entry.skill.id).toBe("@acme/tone");
    expect(typed.rest).toBe("make it shorter");
  });

  it("takes an agent named exactly, alone or with text", () => {
    expect(parse("/run-report")!.rest).toBe("");
    const typed = parse("/run-report for Q3\nplease")!;
    expect(typed.entry.kind).toBe("agent");
    expect(typed.rest).toBe("for Q3\nplease");
  });

  it("is plain text unless the token is exactly one name", () => {
    expect(parse("/ton hello")).toBeNull();
    expect(parse("/Tone hello")).toBeNull();
    expect(parse("/nothing hello")).toBeNull();
    expect(parse("tone hello")).toBeNull();
    expect(parse("hello /tone")).toBeNull();
  });

  it("is plain text when two listed names collide", () => {
    const twins: ChatCommands = {
      skills: [
        { id: "@a/tone", name: "tone", description: "", version: null },
        { id: "@b/tone", name: "tone", description: "", version: null },
      ],
      agents: [],
    };
    expect(parseTypedCommand("/tone hi", twins, idle)).toBeNull();
  });

  it("offers no agent while a turn runs, and no skill where none can be pinned", () => {
    expect(parse("/run-report hi", { ...idle, running: true })).toBeNull();
    expect(parse("/tone hi", { ...idle, canPin: false })).toBeNull();
  });
});

describe("typedSendPlan", () => {
  const agent = { kind: "agent", agent: { name: "run-report", title: "Report" } } as const;
  const pin = { kind: "pin", pinned: ["@a/b"] } as const;

  it("sends the rest, with the chosen agent chip riding on the send (the send clears it)", () => {
    expect(typedSendPlan(agent, "for Q3", false)).toBe("send");
    expect(typedSendPlan(pin, "make it shorter", false)).toBe("send");
    expect(typedSendPlan(pin, "", true)).toBe("send");
  });

  it("sends an agent named alone through the thread, and only pins a skill named alone", () => {
    expect(typedSendPlan(agent, "  ", false)).toBe("agent-only");
    expect(typedSendPlan(pin, "", false)).toBe("stay");
    expect(typedSendPlan({ kind: "close" }, "", false)).toBe("stay");
  });

  it("sends nothing when the pin is refused at the cap", () => {
    expect(typedSendPlan({ kind: "refuse" }, "make it shorter", false)).toBe("stay");
  });
});

describe("dismissalFor", () => {
  it("holds for the draft Escape was pressed on, and forgets it on any other text", () => {
    expect(dismissalFor("/", "/")).toBe("/");
    expect(dismissalFor("/", "/to")).toBeNull();
    // So typing `/` again, after leaving it, reopens the menu.
    expect(dismissalFor(dismissalFor("/", "hello"), "/")).toBeNull();
    expect(dismissalFor(null, "/")).toBeNull();
  });
});

describe("isComposingKey", () => {
  it("is an IME key by isComposing or by Safari's keyCode 229", () => {
    expect(isComposingKey({ keyCode: 13, nativeEvent: { isComposing: true } })).toBe(true);
    expect(isComposingKey({ keyCode: 229, nativeEvent: { isComposing: false } })).toBe(true);
    expect(isComposingKey({ keyCode: 13, nativeEvent: { isComposing: false } })).toBe(false);
  });
});

describe("an agent title past the part's limit", () => {
  it("is cut to the limit, not left to make the server refuse the message", () => {
    const long: ChatCommands = {
      skills: [],
      agents: [{ name: "run-long", title: "x".repeat(300), description: "" }],
    };
    const choice = slashChoice(slashEntries(long, "", idle)[0]!, []);
    expect(choice.kind === "agent" && choice.agent.title).toHaveLength(200);
  });
});
