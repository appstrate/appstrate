// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/orgs/:orgId/chat/sessions/:id/integrations`: the integrations a conversation reached,
 * read off the call journal — its own calls and those of the runs it launched — each once, in
 * order of first call, for the conversation's author only, never across organizations.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { connectionCalls } from "@appstrate/db/schema";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  memberContext,
  orgOnlyHeaders,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { seedPackage, seedRun } from "../../../apps/api/test/helpers/seed.ts";

const app = getTestApp();

function orgCall(ctx: TestContext, path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(`/api/orgs/${ctx.orgId}/chat${path}`, {
    ...init,
    headers: { ...orgOnlyHeaders(ctx), "Content-Type": "application/json" },
  });
}

async function createSession(ctx: TestContext): Promise<string> {
  const res = await orgCall(ctx, "/sessions", { method: "POST", body: "{}" });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

let seq = 0;
async function journal(
  ctx: TestContext,
  integrationId: string,
  at: string,
  context: { chatSessionId?: string; runId?: string },
): Promise<void> {
  seq += 1;
  await db.insert(connectionCalls).values({
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    integrationId,
    actorType: "user",
    actorId: ctx.user.id,
    authMethod: "session",
    method: "GET",
    host: "api.example.com",
    outcome: "200",
    durationMs: 12,
    requestId: `req_journal_${seq}`,
    createdAt: new Date(at),
    ...context,
  });
}

async function launchedRun(ctx: TestContext, chatSessionId: string): Promise<string> {
  const agent = await seedPackage({ orgId: ctx.orgId, id: `@${ctx.org.slug}/writer-${++seq}` });
  const run = await seedRun({
    packageId: agent.id,
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    userId: ctx.user.id,
    status: "success",
    chatSessionId,
  });
  return run.id;
}

async function integrationsOf(ctx: TestContext, sessionId: string): Promise<unknown> {
  const res = await orgCall(ctx, `/sessions/${sessionId}/integrations`);
  expect(res.status).toBe(200);
  return res.json();
}

describe("chat session integrations", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orgreach" });
  });

  it("lists none for a conversation that made no call", async () => {
    const id = await createSession(ctx);
    expect(await integrationsOf(ctx, id)).toEqual({ object: "list", data: [], hasMore: false });
  });

  it("lists its own calls and its runs' calls, each integration once, in order of first call", async () => {
    await seedPackage({
      orgId: ctx.orgId,
      id: "@orgreach/gmail",
      type: "integration",
      draftManifest: {
        name: "@orgreach/gmail",
        version: "1.0.0",
        type: "integration",
        display_name: "Gmail",
        icon: "logos:google-gmail",
      },
    });
    const id = await createSession(ctx);
    const other = await createSession(ctx);
    const runId = await launchedRun(ctx, id);

    await journal(ctx, "@orgreach/clickup", "2026-11-01T10:02:00Z", { runId });
    await journal(ctx, "@orgreach/gmail", "2026-11-01T10:01:00Z", { chatSessionId: id });
    await journal(ctx, "@orgreach/gmail", "2026-11-01T10:03:00Z", { runId });
    await journal(ctx, "@orgreach/clickup", "2026-11-01T10:04:00Z", { chatSessionId: id });
    // Another conversation's call, and a call outside any conversation.
    await journal(ctx, "@orgreach/notion", "2026-11-01T10:00:00Z", { chatSessionId: other });
    await journal(ctx, "@orgreach/slack", "2026-11-01T10:00:00Z", {});

    expect(await integrationsOf(ctx, id)).toEqual({
      object: "list",
      data: [
        { id: "@orgreach/gmail", display_name: "Gmail", icon: "logos:google-gmail" },
        // No package behind it: named by its id.
        { id: "@orgreach/clickup", display_name: "@orgreach/clickup", icon: null },
      ],
      hasMore: false,
    });
  });

  it("never counts another organization's rows", async () => {
    const id = await createSession(ctx);
    const runId = await launchedRun(ctx, id);
    const stranger = await createTestContext({ orgSlug: "orgstranger" });
    // Rows naming this conversation and this run, written under another organization.
    await journal(stranger, "@orgstranger/leak", "2026-11-01T10:00:00Z", { chatSessionId: id });
    await journal(stranger, "@orgstranger/leak", "2026-11-01T10:00:00Z", { runId });

    expect(await integrationsOf(ctx, id)).toEqual({ object: "list", data: [], hasMore: false });
  });

  it("refuses another member's conversation and a missing one as not found", async () => {
    const id = await createSession(ctx);
    await journal(ctx, "@orgreach/gmail", "2026-11-01T10:00:00Z", { chatSessionId: id });
    const member = await memberContext(ctx, "member", "operator");

    expect((await orgCall(member, `/sessions/${id}/integrations`)).status).toBe(404);
    expect((await orgCall(ctx, "/sessions/chs_missing/integrations")).status).toBe(404);
  });
});
