// SPDX-License-Identifier: Apache-2.0

/**
 * The assistant loading a skill's `SKILL.md` pins it to a persisted conversation, through
 * `read_resource` and the platform `read` tool alike: the text for this turn, a receipt in the
 * replay, the pin on the row. A pin that cannot be made (cap, budget, turn released) leaves the
 * read a plain one, with a note; an ephemeral turn and a skill's other files read as before. The
 * handler side (the turn's injected set and budget, the next turn's injection) is in
 * `chat-stream-handler.test.ts`; the turn's budget bookkeeping in `skills.test.ts`.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { ExtensionAPI } from "@appstrate/runner-pi";
import { db } from "@appstrate/db/client";
import { chatSessions } from "@appstrate/db/schema";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../../apps/api/test/helpers/auth.ts";
import { buildPlatformMcpTools } from "../src/pi-chat/mcp-tools.ts";
import { PiChatUiStreamMapper } from "../src/pi-chat/ui-stream-mapper.ts";
import { pinAssistantSkill } from "../src/persistence.ts";
import { mintSessionId } from "../src/session-id.ts";
import {
  MAX_PINNED_SKILLS,
  turnSkillLoad,
  type PinnedSkillStatus,
  type SkillLoad,
} from "../src/skills.ts";
import { inertTurnSpaces } from "./turn-spaces.ts";

const MCP_URL = "http://127.0.0.1:1/api/mcp/o/org_1?renders_cards=true";
const SKILL = "@acme/tone";
const SKILL_MD = "skill://spc_1/acme/tone/tone/SKILL.md";
const FILE = "skill://spc_1/acme/tone/tone/guide.md";
/** The same skill's draft: not the definition the conversation injects. */
const ELSEWHERE_MD = "skill://spc_1/acme/tone@draft/tone/SKILL.md";
const STREAM = "strm_turn";
const TEXT = "---\nname: tone\n---\nAlways answer in haiku.\n";

/** The platform MCP server: serves every skill file as text, and a `read` tool embedding it. */
const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const msg = (await req.json()) as { id?: unknown; method?: string; params?: unknown };
  if (msg.id === undefined) return new Response(null, { status: 202 });
  const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: msg.id, result });
  const resource = (uri: string) => ({
    uri,
    mimeType: "text/markdown",
    text: uri.endsWith("/SKILL.md") ? TEXT : "A guide.",
  });
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "stub", version: "1.0.0" },
      });
    case "tools/list":
      return reply({
        tools: [
          {
            name: "read",
            inputSchema: { type: "object", properties: { uri: { type: "string" } } },
          },
        ],
      });
    case "resources/read":
      return reply({ contents: [resource((msg.params as { uri: string }).uri)] });
    case "tools/call": {
      // A read of the SKILL.md also embeds one of the skill's files.
      const { uri } = (msg.params as { arguments: { uri: string } }).arguments;
      return reply({
        content: [
          { type: "resource", resource: resource(uri) },
          ...(uri === SKILL_MD ? [{ type: "resource", resource: resource(FILE) }] : []),
        ],
      });
    }
    default:
      return reply({});
  }
}) as typeof fetch;

interface Tool {
  name: string;
  execute: (id: string, params: unknown) => Promise<{ content: Array<{ text?: string }> }>;
}

async function tools(skillLoad?: SkillLoad) {
  const built = await buildPlatformMcpTools({
    url: MCP_URL,
    headers: { authorization: "Bearer loopback" },
    organization: inertTurnSpaces(),
    writeChunk: () => {},
    signal: new AbortController().signal,
    turnBudget: { deadlineAt: Date.now() + 60_000, stepCount: () => 0 },
    fetch: stubFetch,
    fileDelivery: { image: true, pdf: true },
    ...(skillLoad ? { skillLoad } : {}),
  });
  const registered: Tool[] = [];
  const pi = { registerTool: (tool: Tool) => registered.push(tool) } as unknown as ExtensionAPI;
  for (const factory of built.extensionFactories) factory(pi);
  return {
    tool: (name: string) => registered.find((tool) => tool.name === name)!,
    close: built.close,
  };
}

/** What the replay keeps of a tool result: the persisted tool output's text. */
function replayed(name: string, result: unknown): string {
  const chunks = new PiChatUiStreamMapper().map({
    type: "tool_execution_end",
    toolName: name,
    toolCallId: "call_1",
    result,
    isError: false,
  });
  return JSON.stringify(chunks);
}

describe("assistant skill load", () => {
  let ctx: TestContext;
  let sessionId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "skillload" });
    sessionId = mintSessionId();
  });

  /** A conversation the turn `STREAM` holds, with `pinned` (and their statuses) stored. */
  async function seed(pinned: string[] = [], skillStatus: Record<string, PinnedSkillStatus> = {}) {
    await db.insert(chatSessions).values({
      id: sessionId,
      orgId: ctx.orgId,
      userId: ctx.user.id,
      title: null,
      pinnedSkills: pinned,
      skillStatus,
      activeStreamId: STREAM,
    });
  }

  async function row() {
    const [found] = await db
      .select({
        pinnedSkills: chatSessions.pinnedSkills,
        assistantSkills: chatSessions.assistantSkills,
        skillStatus: chatSessions.skillStatus,
      })
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId));
    return found;
  }

  /** The persisted turn's load: the conversation injects `SKILL` from `SKILL_MD`. */
  const persistedLoad = (
    budgetLeft = 64_000,
    turn: { pinned?: string[]; injected?: string[] } = {},
  ) =>
    turnSkillLoad({
      uris: new Map([[SKILL, SKILL_MD]]),
      pinned: turn.pinned ?? [],
      injected: turn.injected ?? [],
      budgetLeft,
      pin: (id, append) => pinAssistantSkill(sessionId, STREAM, id, append),
    });

  const RECEIPT = JSON.stringify(
    JSON.stringify({ uri: SKILL_MD, skill: SKILL, pinned: true }),
  ).slice(1, -1);
  const NOT_PINNED = "read for this turn but not pinned";

  for (const name of ["read_resource", "read"]) {
    it(`${name}: pins the skill, returns its text this turn and replays a receipt`, async () => {
      await seed(["@acme/other"]);
      const turn = await tools(persistedLoad());
      try {
        const result = await turn.tool(name).execute("call_1", { uri: SKILL_MD });
        expect(JSON.stringify(result.content)).toContain("Always answer in haiku.");
        const replay = replayed(name, result);
        expect(replay).not.toContain("Always answer in haiku.");
        expect(replay).toContain(RECEIPT);
        expect(await row()).toEqual({
          pinnedSkills: ["@acme/other", SKILL],
          assistantSkills: [SKILL],
          skillStatus: { [SKILL]: "injected" },
        });
      } finally {
        await turn.close();
      }
    });
  }

  it("read: keeps the receipts of the other files the read embedded", async () => {
    await seed();
    const turn = await tools(persistedLoad());
    try {
      const result = await turn.tool("read").execute("call_1", { uri: SKILL_MD });
      expect(JSON.stringify(result.content)).toContain("A guide.");
      const replay = replayed("read", result);
      expect(replay).toContain(RECEIPT);
      expect(replay).not.toContain("A guide.");
      expect(replay).toContain(JSON.stringify(FILE).slice(1, -1));
    } finally {
      await turn.close();
    }
  });

  it("reads a skill the turn injected without a write, and replays a receipt while it is pinned", async () => {
    await seed([SKILL]);
    const turn = await tools(persistedLoad(64_000, { pinned: [SKILL], injected: [SKILL] }));
    try {
      const result = await turn.tool("read_resource").execute("call_1", { uri: SKILL_MD });
      expect(JSON.stringify(result.content)).toContain("Always answer in haiku.");
      // A pin already: the system prompt carries it on later turns, never the replay.
      const replay = replayed("read_resource", result);
      expect(replay).not.toContain("Always answer in haiku.");
      expect(replay).toContain(RECEIPT);
      expect(await row()).toEqual({ pinnedSkills: [SKILL], assistantSkills: [], skillStatus: {} });
    } finally {
      await turn.close();
    }
  });

  for (const [label, turnState] of [
    ["injected at the turn's start", { pinned: [SKILL], injected: [SKILL] }],
    ["pinned by this turn's own load", {}],
  ] as const) {
    it(`re-reads plainly a skill ${label} that another tab unpinned meanwhile, never re-pinning it`, async () => {
      await seed(turnState.pinned ? [...turnState.pinned] : []);
      const turn = await tools(
        persistedLoad(64_000, {
          pinned: turnState.pinned ? [...turnState.pinned] : [],
          injected: turnState.injected ? [...turnState.injected] : [],
        }),
      );
      try {
        await turn.tool("read_resource").execute("call_1", { uri: SKILL_MD });
        await db
          .update(chatSessions)
          .set({ pinnedSkills: [], assistantSkills: [], skillStatus: {} })
          .where(eq(chatSessions.id, sessionId));
        const result = await turn.tool("read_resource").execute("call_2", { uri: SKILL_MD });
        const replay = replayed("read_resource", result);
        expect(replay).toContain("Always answer in haiku.");
        expect(replay).not.toContain(RECEIPT);
        expect(await row()).toEqual({ pinnedSkills: [], assistantSkills: [], skillStatus: {} });
      } finally {
        await turn.close();
      }
    });
  }

  it("reads another definition of the skill plainly, its text kept in the replay", async () => {
    await seed();
    const turn = await tools(persistedLoad());
    try {
      const result = await turn.tool("read_resource").execute("call_1", { uri: ELSEWHERE_MD });
      expect(replayed("read_resource", result)).toContain("Always answer in haiku.");
      expect(await row()).toEqual({ pinnedSkills: [], assistantSkills: [], skillStatus: {} });
    } finally {
      await turn.close();
    }
  });

  it("reads plainly a pin the turn left out over budget: no pin, no budget, no note", async () => {
    await seed([SKILL], { [SKILL]: "over_budget" });
    const turn = await tools(persistedLoad(0, { pinned: [SKILL] }));
    try {
      const result = await turn.tool("read_resource").execute("call_1", { uri: SKILL_MD });
      expect(JSON.stringify(result.content)).toContain("Always answer in haiku.");
      expect(JSON.stringify(result.content)).not.toContain(NOT_PINNED);
      const replay = replayed("read_resource", result);
      expect(replay).toContain("Always answer in haiku.");
      expect(replay).not.toContain(RECEIPT);
      expect(await row()).toEqual({
        pinnedSkills: [SKILL],
        assistantSkills: [],
        skillStatus: { [SKILL]: "over_budget" },
      });
    } finally {
      await turn.close();
    }
  });

  const FIVE = ["@acme/a", "@acme/b", "@acme/c", "@acme/d", "@acme/e"];
  for (const [label, setup, budgetLeft, says] of [
    [
      "the conversation already pins five skills",
      () => seed(FIVE),
      64_000,
      "already pins 5 skills",
    ],
    [
      "its text is over the budget the turn has left",
      () => seed(),
      TEXT.length - 1,
      "does not fit",
    ],
    [
      "the turn lost the conversation",
      async () => {
        await seed();
        // Stopped, or taken over by another turn.
        await db
          .update(chatSessions)
          .set({ activeStreamId: "strm_next" })
          .where(eq(chatSessions.id, sessionId));
      },
      64_000,
      "no longer holds the conversation",
    ],
  ] as const) {
    it(`returns the text with a note, pinning nothing, when ${label}`, async () => {
      await setup();
      const before = await row();
      const turn = await tools(persistedLoad(budgetLeft));
      try {
        const result = await turn.tool("read_resource").execute("call_1", { uri: SKILL_MD });
        const shown = JSON.stringify(result.content);
        expect(shown).toContain("Always answer in haiku.");
        expect(shown).toContain(NOT_PINNED);
        expect(shown).toContain(says);
        const replay = replayed("read_resource", result);
        expect(replay).toContain("Always answer in haiku.");
        expect(replay).not.toContain(RECEIPT);
        expect(await row()).toEqual(before);
      } finally {
        await turn.close();
      }
    });
  }

  it("keeps an ephemeral turn's load a plain read, and a skill's other files unchanged", async () => {
    await seed();
    const ephemeral = await tools();
    const persisted = await tools(persistedLoad());
    try {
      const plain = await ephemeral.tool("read_resource").execute("call_1", { uri: SKILL_MD });
      expect(replayed("read_resource", plain)).toContain("Always answer in haiku.");
      const file = await persisted.tool("read_resource").execute("call_2", { uri: FILE });
      expect(replayed("read_resource", file)).toContain("A guide.");
      expect(await row()).toEqual({ pinnedSkills: [], assistantSkills: [], skillStatus: {} });
    } finally {
      await ephemeral.close();
      await persisted.close();
    }
  });
});

describe("pinAssistantSkill", () => {
  let ctx: TestContext;
  let sessionId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "skillpin" });
    sessionId = mintSessionId();
  });

  async function seed(pinned: string[]) {
    await db.insert(chatSessions).values({
      id: sessionId,
      orgId: ctx.orgId,
      userId: ctx.user.id,
      title: null,
      pinnedSkills: pinned,
      activeStreamId: STREAM,
    });
  }

  async function stored() {
    const [found] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
    return found;
  }

  it("never writes a skill already pinned, even at the cap, and reports it", async () => {
    const five = ["@acme/a", "@acme/b", "@acme/c", "@acme/d", SKILL];
    await seed(five);
    expect(await pinAssistantSkill(sessionId, STREAM, SKILL, true)).toBe("already_pinned");
    expect(await stored()).toMatchObject({
      pinnedSkills: five,
      assistantSkills: [],
      skillStatus: {},
    });
  });

  it("only checks without `append`, whoever holds the conversation", async () => {
    await seed([SKILL]);
    expect(await pinAssistantSkill(sessionId, "strm_other", SKILL, false)).toBe("already_pinned");
    expect(await pinAssistantSkill(sessionId, STREAM, "@acme/x", false)).toBe("not_pinned");
    expect(await stored()).toMatchObject({ pinnedSkills: [SKILL], assistantSkills: [] });
  });

  it("lets exactly one of two concurrent pins take the last place", async () => {
    await seed(["@acme/a", "@acme/b", "@acme/c", "@acme/d"]);
    const outcomes = await Promise.all([
      pinAssistantSkill(sessionId, STREAM, "@acme/x", true),
      pinAssistantSkill(sessionId, STREAM, "@acme/y", true),
    ]);
    expect(outcomes.sort()).toEqual(["full", "pinned"]);
    const found = await stored();
    expect(found?.pinnedSkills).toHaveLength(MAX_PINNED_SKILLS);
    expect(found?.assistantSkills).toHaveLength(1);
  });
});

describe("chat_sessions skill constraints", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "skillchecks" });
  });

  const insert = (pinnedSkills: string[], assistantSkills: string[]) =>
    db.insert(chatSessions).values({
      id: mintSessionId(),
      orgId: ctx.orgId,
      userId: ctx.user.id,
      title: null,
      pinnedSkills,
      assistantSkills,
    });

  /** The constraint a write broke, as the driver reports it (postgres.js or PGlite). */
  const violated = (work: Promise<unknown>) =>
    work.then(
      () => "none",
      (error: unknown) => {
        const cause = (error as { cause?: Record<string, unknown> }).cause ?? {};
        return String(cause.constraint_name ?? cause.constraint ?? error);
      },
    );

  it("refuses an assistant pin that is not a pin", async () => {
    expect(await violated(insert(["@acme/a"], ["@acme/b"]))).toContain(
      "chat_sessions_assistant_skills_pinned",
    );
  });

  it(`refuses more than ${MAX_PINNED_SKILLS} pins`, async () => {
    const six = ["@acme/a", "@acme/b", "@acme/c", "@acme/d", "@acme/e", "@acme/f"];
    expect(await violated(insert(six, []))).toContain("chat_sessions_pinned_skills_cap");
  });

  it("accepts the cap, with the assistant's pins among them", async () => {
    const five = ["@acme/a", "@acme/b", "@acme/c", "@acme/d", "@acme/e"];
    expect(await violated(insert(five, ["@acme/c"]))).toBe("none");
  });
});
