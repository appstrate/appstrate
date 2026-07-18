// SPDX-License-Identifier: Apache-2.0

/**
 * `chat_session_update` SSE fan-out.
 *
 * The chat module publishes a signal-only NOTIFY (packages/module-chat/src/
 * realtime.ts) and the platform's realtime service fans it out to SSE
 * subscribers gated on org + EXACT owner match — chat sessions are strictly
 * user-owned, so another member of the same org must never receive the frame.
 * Exercises the real path end-to-end: notifySessionUpdate → PG NOTIFY →
 * LISTEN dispatch → SSE stream frame.
 */

import { describe, expect, it, beforeEach, beforeAll } from "bun:test";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { collectSSEEvents } from "../../../apps/api/test/helpers/sse.ts";
import { initRealtime } from "../../../apps/api/src/services/realtime.ts";
import { notifySessionUpdate } from "../src/realtime.ts";

const app = getTestApp();

/** Let the PG LISTEN dispatcher register/deliver. */
const wait = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

async function openStream(ctx: TestContext): Promise<Response> {
  const res = await app.request(
    `/api/realtime/runs?orgId=${ctx.orgId}&applicationId=${ctx.defaultAppId}`,
    { headers: { Cookie: ctx.cookie, Accept: "text/event-stream" } },
  );
  expect(res.status).toBe(200);
  return res;
}

async function createSession(ctx: TestContext): Promise<{ id: string; userId: string }> {
  const res = await app.request("/api/chat/sessions", {
    method: "POST",
    headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  return { id, userId: ctx.user.id };
}

describe("chat_session_update SSE fan-out", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    await initRealtime();
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chatsse" });
  });

  it("delivers the frame to the owner's SSE subscription", async () => {
    const session = await createSession(ctx);
    const res = await openStream(ctx);
    await wait();

    await notifySessionUpdate(session.id, ctx.orgId, session.userId);

    const events = await collectSSEEvents(res.body!, 1, {
      timeoutMs: 3000,
      ignoreEvents: ["ping"],
    });
    const frame = events.find((e) => e.event === "chat_session_update");
    expect(frame).toBeDefined();
    const data = JSON.parse(frame!.data) as { sessionId: string; userId: string };
    expect(data.sessionId).toBe(session.id);
    expect(data.userId).toBe(session.userId);
  });

  it("never delivers another user's session frame (exact-owner gate)", async () => {
    const session = await createSession(ctx);
    const res = await openStream(ctx);
    await wait();

    // A frame owned by someone else in the org, then the subscriber's own —
    // dispatch is ordered, so receiving ONLY the second proves the first was
    // filtered rather than still in flight.
    await notifySessionUpdate("chs_foreign", ctx.orgId, "someone-else");
    await notifySessionUpdate(session.id, ctx.orgId, session.userId);

    const events = await collectSSEEvents(res.body!, 1, {
      timeoutMs: 3000,
      ignoreEvents: ["ping"],
    });
    const chatFrames = events.filter((e) => e.event === "chat_session_update");
    expect(chatFrames).toHaveLength(1);
    expect((JSON.parse(chatFrames[0]!.data) as { sessionId: string }).sessionId).toBe(session.id);
  });

  it("never delivers frames across organizations", async () => {
    const other = await createTestContext({ orgSlug: "chatsse-other" });
    const session = await createSession(ctx);
    const res = await openStream(other);
    await wait();

    // Cross-org frame (even for the SAME user id) must be filtered; the
    // subscriber's own-org frame proves delivery still works.
    await notifySessionUpdate(session.id, ctx.orgId, other.user.id);
    const ownSession = await createSession(other);
    await notifySessionUpdate(ownSession.id, other.orgId, other.user.id);

    const events = await collectSSEEvents(res.body!, 1, {
      timeoutMs: 3000,
      ignoreEvents: ["ping"],
    });
    const chatFrames = events.filter((e) => e.event === "chat_session_update");
    expect(chatFrames).toHaveLength(1);
    expect((JSON.parse(chatFrames[0]!.data) as { sessionId: string }).sessionId).toBe(
      ownSession.id,
    );
  });
});
