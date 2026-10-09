// SPDX-License-Identifier: Apache-2.0

/**
 * The `memory` MCP tool: declared for the person's own credential when their
 * switch and the org's are on, origin set by the endpoint, never by the model.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, profiles, userMemories } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import { truncateAll, db } from "../../../../../test/helpers/db.ts";
import {
  createTestContext,
  createTestOrg,
  type TestContext,
} from "../../../../../test/helpers/auth.ts";
import { seedApiKey } from "../../../../../test/helpers/seed.ts";
import {
  MCP_ACCEPT,
  mcpPath,
  mcpRpc,
  type JsonRpcEnvelope,
} from "../../../../../test/helpers/mcp.ts";
import { registerTestPlatformApp } from "../../../../../test/helpers/platform-app.ts";
import { mintMcpLoopbackToken } from "../../../../../../../packages/module-chat/src/loopback-auth.ts";

const app = getTestApp();
await registerTestPlatformApp();
const rpc = mcpRpc(app);

async function toolNames(headers: Record<string, string>): Promise<string[]> {
  const { envelope } = await rpc(headers, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  return ((envelope.result?.tools as Array<{ name: string }>) ?? []).map((t) => t.name);
}

async function callMemory(headers: Record<string, string>, args: Record<string, unknown>) {
  const { envelope } = await rpc(headers, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "memory", arguments: args },
  });
  return envelope as JsonRpcEnvelope;
}

function payload(envelope: JsonRpcEnvelope): Record<string, unknown> {
  const content = (envelope.result?.content as Array<{ text: string }>) ?? [];
  return content[0] ? (JSON.parse(content[0].text) as Record<string, unknown>) : {};
}

describe("memory MCP tool", () => {
  let ctx: TestContext;
  let headers: Record<string, string>;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    headers = { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId };
  });

  it("is declared for the person's own session", async () => {
    expect(await toolNames(headers)).toContain("memory");
  });

  it("offers `view` to an external client, not to the chat (which holds the core)", async () => {
    const actionsFor = async (path: string) => {
      const res = await app.request(path, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      const tools = ((await res.json()) as { result: { tools: Array<Record<string, any>> } }).result
        .tools;
      return tools.find((t) => t.name === "memory")!.inputSchema.properties.action.enum as string[];
    };
    expect(await actionsFor(mcpPath(headers))).toContain("view");
    expect(await actionsFor(`${mcpPath(headers)}?context=injected`)).not.toContain("view");
  });

  it("works for the chat's loopback token, which the memory routes refuse", async () => {
    const token = mintMcpLoopbackToken({
      userId: ctx.user.id,
      email: ctx.user.email,
      name: ctx.user.name,
      orgId: ctx.orgId,
      orgRole: "owner",
      permissions: ["mcp:read", "mcp:invoke", "chat:write", "memory:read", "memory:write"],
    });
    const chat = { Authorization: `Bearer ${token}`, "X-Org-Id": ctx.orgId };
    const added = await callMemory(chat, { action: "add", type: "fact", content: "Via the chat" });
    expect(added.result?.isError).toBe(false);
  });

  it("is not declared for an API key", async () => {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["mcp:read", "mcp:invoke"],
    });
    const names = await toolNames({ Authorization: `Bearer ${key.rawKey}`, "X-Org-Id": ctx.orgId });
    expect(names).not.toContain("memory");
  });

  it("refuses every call while the person or the org switched it off", async () => {
    const refused = async () => {
      const res = await callMemory(headers, { action: "view" });
      return res.result?.isError === true && JSON.stringify(payload(res)).includes("memory_off");
    };
    await db.update(profiles).set({ assistantMemory: false }).where(eq(profiles.id, ctx.user.id));
    expect(await refused()).toBe(true);
    await db.update(profiles).set({ assistantMemory: true }).where(eq(profiles.id, ctx.user.id));
    expect(await refused()).toBe(false);
    await db
      .update(organizations)
      .set({ orgSettings: { assistant_memory: false } })
      .where(eq(organizations.id, ctx.orgId));
    expect(await refused()).toBe(true);
  });

  it("writes with the endpoint's org as origin, or none for scope me, and views the core", async () => {
    await callMemory(headers, { action: "add", type: "project", content: "Runs the Tastet map" });
    await callMemory(headers, {
      action: "add",
      type: "preference",
      content: "Answers in French",
      scope: "me",
    });
    const rows = await db.select().from(userMemories).where(eq(userMemories.userId, ctx.user.id));
    expect(rows.map((r) => [r.content, r.orgId, r.createdBy]).sort()).toEqual([
      ["Answers in French", null, "assistant"],
      ["Runs the Tastet map", ctx.orgId, "assistant"],
    ]);

    const view = payload(await callMemory(headers, { action: "view" }));
    expect(String(view.memory)).toContain("### About the person");
    expect(String(view.memory)).toContain("Answers in French");
    expect(String(view.memory)).toContain("Runs the Tastet map");
  });

  it("files a preference as about the person, whatever scope the model asks for", async () => {
    await callMemory(headers, {
      action: "add",
      type: "preference",
      content: "Short answers",
      scope: "org",
    });
    const [row] = await db.select().from(userMemories).where(eq(userMemories.userId, ctx.user.id));
    expect(row!.orgId).toBeNull();
  });

  it("keeps what was learned in one organization out of another", async () => {
    await callMemory(headers, {
      action: "add",
      type: "project",
      content: "Leads Orion with Pierre",
    });
    await callMemory(headers, { action: "add", type: "preference", content: "Short answers" });
    const other = await createTestOrg(ctx.user.id);
    const otherHeaders = { Cookie: ctx.cookie, "X-Org-Id": other.org.id };
    const view = String(payload(await callMemory(otherHeaders, { action: "view" })).memory);
    expect(view).toContain("Short answers");
    expect(view).not.toContain("Orion");
    const actions = await (async () => {
      const { envelope } = await rpc(otherHeaders, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      const tool = (envelope.result?.tools as Array<Record<string, any>>).find(
        (t) => t.name === "memory",
      )!;
      return tool.inputSchema.properties.action.enum as string[];
    })();
    expect(actions).not.toContain("search");
  });

  it("cannot rewrite or remove, from one organization, what was learned in another", async () => {
    const added = payload(
      await callMemory(headers, { action: "add", type: "project", content: "Leads Orion" }),
    );
    const id = (added.added as { id: string }).id;
    const other = await createTestOrg(ctx.user.id);
    const otherHeaders = { Cookie: ctx.cookie, "X-Org-Id": other.org.id };
    const replaced = await callMemory(otherHeaders, { action: "replace", id, content: "Hijacked" });
    expect(replaced.result?.isError).toBe(true);
    const removed = await callMemory(otherHeaders, { action: "remove", id });
    expect(removed.result?.isError).toBe(true);
    const [row] = await db.select().from(userMemories).where(eq(userMemories.id, id));
    expect(row!.content).toBe("Leads Orion");
  });

  it("holds the budget under concurrent writes", async () => {
    const writes = Array.from({ length: 8 }, () =>
      callMemory(headers, { action: "add", type: "fact", content: "y".repeat(400) }),
    );
    await Promise.all(writes);
    const rows = await db.select().from(userMemories).where(eq(userMemories.userId, ctx.user.id));
    const used = rows.reduce((sum, r) => sum + r.content.length, 0);
    expect(used).toBeLessThanOrEqual(2000);
  });

  it("answers memory_full as a tool error the model can act on", async () => {
    for (let i = 0; i < 4; i++) {
      await callMemory(headers, { action: "add", type: "fact", content: "x".repeat(500) });
    }
    const full = await callMemory(headers, { action: "add", type: "fact", content: "one more" });
    expect(full.result?.isError).toBe(true);
    expect(JSON.stringify(payload(full))).toContain("memory_full");
  });
});
