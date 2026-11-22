// SPDX-License-Identifier: Apache-2.0

/**
 * The assistant loading a skill's `SKILL.md` pins it to a persisted conversation, through
 * `read_resource` and the platform `read` tool alike: the text for this turn, a receipt in the
 * replay, the pin on the row. A refused load (cap, budget) marks nothing; an ephemeral turn and
 * a skill's other files read as before. The handler side (the turn's injected set and budget,
 * the next turn's injection) is in `chat-stream-handler.test.ts`.
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
import { turnSkillLoad, type SkillLoad } from "../src/skills.ts";
import { inertTurnSpaces } from "./turn-spaces.ts";

const MCP_URL = "http://127.0.0.1:1/api/mcp/o/org_1?renders_cards=true";
const SKILL = "@acme/tone";
const SKILL_MD = "skill://spc_1/acme/tone/tone/SKILL.md";
const FILE = "skill://spc_1/acme/tone/tone/guide.md";
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
    text: uri === SKILL_MD ? TEXT : "A guide.",
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
      const { uri } = (msg.params as { arguments: { uri: string } }).arguments;
      return reply({ content: [{ type: "resource", resource: resource(uri) }] });
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

  async function seed(pinned: string[] = [], skillStatus: Record<string, string> = {}) {
    await db.insert(chatSessions).values({
      id: sessionId,
      orgId: ctx.orgId,
      userId: ctx.user.id,
      title: null,
      pinnedSkills: pinned,
      skillStatus,
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

  const persistedLoad = (budgetLeft = 64_000, injected: string[] = []) =>
    turnSkillLoad({ injected, budgetLeft, pin: (id) => pinAssistantSkill(sessionId, id) });

  for (const name of ["read_resource", "read"]) {
    it(`${name}: pins the skill, returns its text this turn and replays a receipt`, async () => {
      await seed(["@acme/other"]);
      const turn = await tools(persistedLoad());
      try {
        const result = await turn.tool(name).execute("call_1", { uri: SKILL_MD });
        expect(JSON.stringify(result.content)).toContain("Always answer in haiku.");
        const replay = replayed(name, result);
        expect(replay).not.toContain("Always answer in haiku.");
        expect(replay).toContain(
          JSON.stringify(JSON.stringify({ uri: SKILL_MD, skill: SKILL, pinned: true })).slice(
            1,
            -1,
          ),
        );
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

  it("reads a skill the turn already injected without a write, and replays a receipt too", async () => {
    await seed([SKILL]);
    const turn = await tools(persistedLoad(64_000, [SKILL]));
    try {
      const result = await turn.tool("read_resource").execute("call_1", { uri: SKILL_MD });
      expect(JSON.stringify(result.content)).toContain("Always answer in haiku.");
      // A pin already: the system prompt carries it on later turns, never the replay.
      const replay = replayed("read_resource", result);
      expect(replay).not.toContain("Always answer in haiku.");
      expect(replay).toContain('\\"pinned\\":true');
      expect(await row()).toEqual({ pinnedSkills: [SKILL], assistantSkills: [], skillStatus: {} });
    } finally {
      await turn.close();
    }
  });

  it("marks injected a pin the turn left out, when its load fits, keeping the user's source", async () => {
    await seed([SKILL], { [SKILL]: "over_budget" });
    // Left out of this turn's prompt: not in the injected set.
    const turn = await tools(persistedLoad(64_000, []));
    try {
      const result = await turn.tool("read_resource").execute("call_1", { uri: SKILL_MD });
      expect(JSON.stringify(result.content)).toContain("Always answer in haiku.");
      expect(replayed("read_resource", result)).not.toContain("Always answer in haiku.");
      expect(await row()).toEqual({
        pinnedSkills: [SKILL],
        assistantSkills: [],
        skillStatus: { [SKILL]: "injected" },
      });
    } finally {
      await turn.close();
    }
  });

  it("refuses a load when the conversation already pins five skills, marking nothing", async () => {
    const five = ["@acme/a", "@acme/b", "@acme/c", "@acme/d", "@acme/e"];
    await seed(five);
    const turn = await tools(persistedLoad());
    try {
      const refused = await turn
        .tool("read_resource")
        .execute("call_1", { uri: SKILL_MD })
        .then(
          () => undefined,
          (error: unknown) => String(error),
        );
      expect(refused).toContain("already pins 5 skills");
      expect(refused).toContain("skills panel");
      expect(await row()).toEqual({ pinnedSkills: five, assistantSkills: [], skillStatus: {} });
    } finally {
      await turn.close();
    }
  });

  it("refuses a load over the budget the turn has left, marking nothing", async () => {
    await seed();
    const turn = await tools(persistedLoad(TEXT.length - 1));
    try {
      const refused = await turn
        .tool("read")
        .execute("call_1", { uri: SKILL_MD })
        .then(
          () => undefined,
          (error: unknown) => String(error),
        );
      expect(refused).toContain("does not fit");
      expect(await row()).toEqual({ pinnedSkills: [], assistantSkills: [], skillStatus: {} });
    } finally {
      await turn.close();
    }
  });

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
