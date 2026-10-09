// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestOrg,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedApiKey } from "../../helpers/seed.ts";
import { USER_MEMORY_PERSONAL_BUDGET_CHARS } from "@appstrate/core/user-memory";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { spaces, userMemories } from "@appstrate/db/schema";
import { removeMember } from "../../../src/services/organizations.ts";
import { ensurePersonalSpaceFor, PERSONAL_SPACE_GRACE_DAYS } from "../../../src/services/spaces.ts";
import { sweepOrphanedPersonalSpaces } from "../../../src/services/personal-space-sweeper.ts";
import { mintMcpLoopbackToken } from "../../../../../packages/module-chat/src/loopback-auth.ts";

const app = getTestApp();

function json(cookie: string, method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

describe("/api/me/memories", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  it("adds, lists, edits and forgets a memory without any org header", async () => {
    const created = await app.request(
      "/api/me/memories",
      json(ctx.cookie, "POST", { type: "preference", content: "Prefers short answers" }),
    );
    expect(created.status).toBe(201);
    const memory = (await created.json()) as Record<string, unknown>;
    expect(memory).toMatchObject({
      type: "preference",
      content: "Prefers short answers",
      orgId: null,
      org_member: true,
      created_by: "user",
    });
    expect(String(memory.id)).toStartWith("mem_");

    const patched = await app.request(
      `/api/me/memories/${memory.id}`,
      json(ctx.cookie, "PATCH", { content: "Prefers very short answers", subject: "tone" }),
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      content: "Prefers very short answers",
      subject: "tone",
    });

    const list = await app.request("/api/me/memories", { headers: { Cookie: ctx.cookie } });
    const body = (await list.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(1);

    const deleted = await app.request(`/api/me/memories/${memory.id}`, json(ctx.cookie, "DELETE"));
    expect(deleted.status).toBe(204);
  });

  it("tags a memory with an org the caller belongs to, and refuses one they do not", async () => {
    const ok = await app.request(
      "/api/me/memories",
      json(ctx.cookie, "POST", {
        type: "project",
        content: "Runs the Tastet map",
        orgId: ctx.orgId,
      }),
    );
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ orgId: ctx.orgId, org_member: true });

    const other = await createTestContext();
    const refused = await app.request(
      "/api/me/memories",
      json(ctx.cookie, "POST", { type: "project", content: "x", orgId: other.orgId }),
    );
    expect(refused.status).toBe(400);
  });

  it("refuses a write that would overflow the budget with memory_full", async () => {
    const chunk = "a".repeat(400);
    for (
      let used = 0;
      used + chunk.length <= USER_MEMORY_PERSONAL_BUDGET_CHARS;
      used += chunk.length
    ) {
      const res = await app.request(
        "/api/me/memories",
        json(ctx.cookie, "POST", { type: "fact", content: chunk }),
      );
      expect(res.status).toBe(201);
    }
    const full = await app.request(
      "/api/me/memories",
      json(ctx.cookie, "POST", { type: "fact", content: chunk }),
    );
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ code: "memory_full", scope: "me" });
  });

  it("refuses a secret", async () => {
    const res = await app.request(
      "/api/me/memories",
      json(ctx.cookie, "POST", {
        type: "fact",
        content: "My key is sk-ant-abcdefghijklmnopqrstuvwxyz",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("forgets by origin", async () => {
    await app.request(
      "/api/me/memories",
      json(ctx.cookie, "POST", { type: "fact", content: "about me" }),
    );
    await app.request(
      "/api/me/memories",
      json(ctx.cookie, "POST", { type: "fact", content: "from the org", orgId: ctx.orgId }),
    );
    const res = await app.request(
      `/api/me/memories?origin=${ctx.orgId}`,
      json(ctx.cookie, "DELETE"),
    );
    expect(await res.json()).toEqual({ deleted: 1 });
    const missing = await app.request("/api/me/memories", json(ctx.cookie, "DELETE"));
    expect(missing.status).toBe(400);
  });

  it("is the person's alone: another user cannot touch it, an API key is refused", async () => {
    const created = await app.request(
      "/api/me/memories",
      json(ctx.cookie, "POST", { type: "fact", content: "mine" }),
    );
    const { id } = (await created.json()) as { id: string };

    const other = await createTestContext();
    const foreign = await app.request(`/api/me/memories/${id}`, json(other.cookie, "DELETE"));
    expect(foreign.status).toBe(404);

    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
    });
    const byKey = await app.request("/api/me/memories", {
      headers: { Authorization: `Bearer ${key.rawKey}` },
    });
    expect(byKey.status).toBe(403);
  });

  it("lists a memory from an org the person left, marked as no longer a member", async () => {
    const { org } = await createTestOrg(ctx.user.id);
    await app.request(
      "/api/me/memories",
      json(ctx.cookie, "POST", { type: "fact", content: "learned there", orgId: org.id }),
    );
    const { db } = await import("@appstrate/db/client");
    const { organizationMembers } = await import("@appstrate/db/schema");
    const { and, eq } = await import("drizzle-orm");
    await db
      .delete(organizationMembers)
      .where(
        and(eq(organizationMembers.orgId, org.id), eq(organizationMembers.userId, ctx.user.id)),
      );

    const list = await app.request("/api/me/memories", { headers: { Cookie: ctx.cookie } });
    const body = (await list.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).toMatchObject({ orgId: org.id, org_member: false });
  });

  it("serves the core: about the person and the named org, not another org", async () => {
    const { org: other } = await createTestOrg(ctx.user.id);
    const add = (body: Record<string, unknown>) =>
      app.request("/api/me/memories", json(ctx.cookie, "POST", body));
    await add({ type: "preference", content: "Short answers" });
    await add({ type: "project", content: "Here", orgId: ctx.orgId });
    await add({ type: "project", content: "Elsewhere", orgId: other.id });

    const core = async (query: string) => {
      const res = await app.request(`/api/me/memories/core${query}`, {
        headers: { Cookie: ctx.cookie },
      });
      return (await res.json()) as { enabled: boolean; memories: Array<{ content: string }> };
    };
    const here = await core(`?orgId=${ctx.orgId}`);
    expect(here.enabled).toBe(true);
    expect(here.memories.map((m) => m.content).sort()).toEqual(["Here", "Short answers"]);
    expect((await core("")).memories.map((m) => m.content)).toEqual(["Short answers"]);

    const stranger = await createTestContext();
    const refused = await app.request(`/api/me/memories/core?orgId=${stranger.orgId}`, {
      headers: { Cookie: ctx.cookie },
    });
    expect(refused.status).toBe(400);

    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
    });
    const byKey = await app.request("/api/me/memories/core", {
      headers: { Authorization: `Bearer ${key.rawKey}` },
    });
    expect(byKey.status).toBe(403);
  });
});

describe("assistant memory switches and lifecycle", () => {
  let owner: TestContext;

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext();
  });

  async function remember(ctx: TestContext, content: string, orgId: string | null) {
    const res = await app.request(
      "/api/me/memories",
      json(ctx.cookie, "POST", { type: "fact", content, orgId }),
    );
    expect(res.status).toBe(201);
  }

  it("the person's switch is read and written on /api/profile, and turns the core off", async () => {
    const before = await app.request("/api/profile", { headers: { Cookie: owner.cookie } });
    expect(((await before.json()) as Record<string, unknown>).assistant_memory).toBe(true);
    const patched = await app.request(
      "/api/profile",
      json(owner.cookie, "PATCH", { assistant_memory: false }),
    );
    expect(((await patched.json()) as Record<string, unknown>).assistant_memory).toBe(false);

    const core = await app.request(`/api/me/memories/core?orgId=${owner.orgId}`, {
      headers: { Cookie: owner.cookie },
    });
    expect(((await core.json()) as { enabled: boolean }).enabled).toBe(false);
  });

  it("an admin erases what members learned in the org, nothing else; a member cannot", async () => {
    const member = await memberContext(owner, "member");
    await remember(member, "learned here", owner.orgId);
    await remember(member, "about me", null);

    const refused = await app.request(
      `/api/orgs/${owner.orgId}/memories`,
      json(member.cookie, "DELETE"),
    );
    expect(refused.status).toBe(403);

    const erased = await app.request(
      `/api/orgs/${owner.orgId}/memories`,
      json(owner.cookie, "DELETE"),
    );
    expect(await erased.json()).toEqual({ deleted: 1 });
    const left = await db
      .select()
      .from(userMemories)
      .where(eq(userMemories.userId, member.user.id));
    expect(left.map((m) => m.content)).toEqual(["about me"]);
  });

  it("erases what a departed member learned once their personal space's window closes", async () => {
    const member = await memberContext(owner, "member");
    const personal = await ensurePersonalSpaceFor(owner.orgId, member.user.id);
    await remember(member, "learned here", owner.orgId);
    await remember(member, "about me", null);
    await removeMember(owner.orgId, member.user.id, {
      userId: owner.user.id,
      firstPartySession: true,
    });

    await sweepOrphanedPersonalSpaces();
    expect(
      await db.select().from(userMemories).where(eq(userMemories.userId, member.user.id)),
    ).toHaveLength(2);

    const past = new Date(Date.now() - (PERSONAL_SPACE_GRACE_DAYS + 1) * 86_400_000);
    await db.update(spaces).set({ orphanedAt: past }).where(eq(spaces.id, personal.id));
    await sweepOrphanedPersonalSpaces();
    const left = await db
      .select()
      .from(userMemories)
      .where(eq(userMemories.userId, member.user.id));
    expect(left.map((m) => m.content)).toEqual(["about me"]);
  });
});

describe("a credential bound to one organization (the chat's token)", () => {
  it("reaches what is about the person and that organization, nothing else, by the same rule as the tool", async () => {
    await truncateAll();
    const ctx = await createTestContext();
    const { org: other } = await createTestOrg(ctx.user.id);
    const add = (body: Record<string, unknown>) =>
      app.request("/api/me/memories", json(ctx.cookie, "POST", body));
    await add({ type: "preference", content: "Short answers" });
    await add({ type: "project", content: "Here", orgId: ctx.orgId });
    await add({ type: "project", content: "Elsewhere", orgId: other.id });

    const token = mintMcpLoopbackToken({
      userId: ctx.user.id,
      email: ctx.user.email,
      name: ctx.user.name,
      orgId: ctx.orgId,
      orgRole: "owner",
      permissions: ["mcp:read", "mcp:invoke", "chat:write", "memory:read", "memory:write"],
    });
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const list = (await (await app.request("/api/me/memories", { headers })).json()) as {
      data: Array<{ content: string }>;
    };
    expect(list.data.map((m) => m.content).sort()).toEqual(["Here", "Short answers"]);

    const elsewhereCore = await app.request(`/api/me/memories/core?orgId=${other.id}`, { headers });
    expect(elsewhereCore.status).toBe(403);

    const writeElsewhere = await app.request("/api/me/memories", {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "fact", content: "x", orgId: other.id }),
    });
    expect(writeElsewhere.status).toBe(403);

    const written = await app.request("/api/me/memories", {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "fact", content: "Written by the chat", orgId: ctx.orgId }),
    });
    expect(((await written.json()) as { created_by: string }).created_by).toBe("assistant");

    const wipe = await app.request("/api/me/memories?origin=all", { method: "DELETE", headers });
    expect(((await wipe.json()) as { deleted: number }).deleted).toBe(3);
    const left = (await (
      await app.request("/api/me/memories", { headers: { Cookie: ctx.cookie } })
    ).json()) as { data: Array<{ content: string }> };
    expect(left.data.map((m) => m.content)).toEqual(["Elsewhere"]);
  });
});
