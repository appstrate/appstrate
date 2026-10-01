// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /api/chat/sessions/:id/approvals/:approvalId`: the person's answer
 * reaches the turn waiting on it, and only a signed-in session can give it.
 * The bearer the model itself holds (the chat's MCP loopback token) is refused,
 * so the model can never approve its own call.
 *
 * The registry is used for real: it is process-local module state, and the
 * route must reach the same instance the turn registered into.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { awaitReply } from "../src/reply-registry.ts";
import type { AskUserReply } from "../src/ask-user-reply.ts";

const awaitApproval = (id: string, sessionId: string, signal: AbortSignal) =>
  awaitReply("approval", id, sessionId, signal, { approved: false });
import { mintMcpLoopbackToken } from "../src/loopback-auth.ts";

const app = getTestApp();

describe("POST /api/chat/sessions/:id/approvals/:approvalId", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chatapproval" });
  });

  async function createSession(): Promise<string> {
    const res = await app.request("/api/chat/sessions", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  function answer(
    sessionId: string,
    approvalId: string,
    body: unknown,
    headers: Record<string, string> = authHeaders(ctx),
  ) {
    return app.request(`/api/chat/sessions/${sessionId}/approvals/${approvalId}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function loopbackHeaders(): Record<string, string> {
    const token = mintMcpLoopbackToken({
      userId: ctx.user.id,
      email: ctx.user.email,
      name: ctx.user.name,
      orgId: ctx.orgId,
      orgRole: "owner",
      permissions: ["chat:read", "chat:write"],
    });
    return {
      Authorization: `Bearer ${token}`,
      "X-Org-Id": ctx.orgId,
      "X-Space-Id": ctx.defaultSpaceId,
    };
  }

  it("hands a signed-in person's answer to the waiting turn", async () => {
    const sessionId = await createSession();
    const turn = new AbortController();
    const waiting = awaitApproval("apr_ok", sessionId, turn.signal);

    const res = await answer(sessionId, "apr_ok", { approved: false, reason: "not now" });
    expect(res.status).toBe(204);
    expect(await waiting).toEqual({ approved: false, reason: "not now" });
  });

  it("answers 404 when the session holds no such approval", async () => {
    const sessionId = await createSession();
    expect((await answer(sessionId, "apr_none", { approved: true })).status).toBe(404);
  });

  it("refuses the model's own loopback bearer and leaves the approval pending", async () => {
    const sessionId = await createSession();
    const turn = new AbortController();
    const waiting = awaitApproval("apr_self", sessionId, turn.signal);

    // Control: the same bearer passes the chat pipeline on a neighbouring route,
    // so the 403 below is the approval guard and not a missing permission.
    const stop = await app.request(`/api/chat/sessions/${sessionId}/stop`, {
      method: "POST",
      headers: loopbackHeaders(),
    });
    expect(stop.status).toBe(204);

    const res = await answer(sessionId, "apr_self", { approved: true }, loopbackHeaders());
    expect(res.status).toBe(403);

    turn.abort();
    expect(await waiting).toEqual({ approved: false });
  });
});

describe("POST /api/chat/sessions/:id/questions/:toolCallId", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chatquestion" });
  });

  async function createSession(): Promise<string> {
    const res = await app.request("/api/chat/sessions", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    return ((await res.json()) as { id: string }).id;
  }

  function reply(sessionId: string, toolCallId: string, body: unknown, headers = authHeaders(ctx)) {
    return app.request(`/api/chat/sessions/${sessionId}/questions/${toolCallId}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  const awaitAnswers = (id: string, sessionId: string, signal: AbortSignal) =>
    awaitReply<AskUserReply>("question", id, sessionId, signal, { status: "cancelled" });

  it("hands a signed-in person's answers to the waiting turn", async () => {
    const sessionId = await createSession();
    const turn = new AbortController();
    const waiting = awaitAnswers("call_ok", sessionId, turn.signal);
    const answers = { target: { selected: ["Veille"], text: "et vite" } };

    const res = await reply(sessionId, "call_ok", { status: "answered", answers });
    expect(res.status).toBe(204);
    expect(await waiting).toEqual({ status: "answered", answers });
  });

  it("does not answer a pending approval with the same id", async () => {
    const sessionId = await createSession();
    const turn = new AbortController();
    const approval = awaitReply("approval", "shared_id", sessionId, turn.signal, {
      approved: false,
    });

    expect((await reply(sessionId, "shared_id", { status: "cancelled" })).status).toBe(404);
    turn.abort();
    expect(await approval).toEqual({ approved: false });
  });

  it("refuses the model's own loopback bearer", async () => {
    const sessionId = await createSession();
    const turn = new AbortController();
    const waiting = awaitAnswers("call_self", sessionId, turn.signal);
    const token = mintMcpLoopbackToken({
      userId: ctx.user.id,
      email: ctx.user.email,
      name: ctx.user.name,
      orgId: ctx.orgId,
      orgRole: "owner",
      permissions: ["chat:read", "chat:write"],
    });
    const res = await reply(sessionId, "call_self", { status: "cancelled" }, {
      Authorization: `Bearer ${token}`,
      "X-Org-Id": ctx.orgId,
      "X-Space-Id": ctx.defaultSpaceId,
    } as never);
    expect(res.status).toBe(403);
    turn.abort();
    expect(await waiting).toEqual({ status: "cancelled" });
  });
});
