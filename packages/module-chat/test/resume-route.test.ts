// SPDX-License-Identifier: Apache-2.0

/**
 * Stale `active_stream_id` markers, and the two sweeps that clear them.
 *
 * A marker is set when a turn starts and cleared by that turn's own teardown.
 * When the producer dies without one (a crash, a restart, an in-memory store
 * on a process that is gone), nothing clears it: the resume GET answered 204
 * and left it, so the sidebar polled a spinner forever and `persistNotice`
 * refused the session forever.
 *
 *   - the resume route clears the marker the first time it misses the store
 *     (guarded by stream id, so a newer turn is never touched), once;
 *   - `chatModule.init` clears every marker at boot on the in-memory tier —
 *     no recording survives a restart there — and none on the Redis tier,
 *     where another replica may own a live turn.
 *
 * Same harness as `stop-route.test.ts`: the real app, a real session row.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatSessions } from "@appstrate/db/schema";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { buildModuleInitContext } from "../../../apps/api/src/lib/modules/registry.ts";
import chatModule from "../src/index.ts";
import {
  closeResumableStore,
  setActiveStream,
  STALE_MARKER_MIN_AGE_MS,
  sweepStaleActiveStreams,
} from "../src/resumable.ts";
import { logger } from "../src/logger.ts";

const app = getTestApp();

/** Nothing listens here — a Redis tier that must never be reached. */
const DEAD_REDIS = "redis://127.0.0.1:1";

const STALE_MARKER_LOG = "chat resume: cleared stale active stream marker";

describe("GET /api/chat/sessions/:id/stream — stale marker", () => {
  let ctx: TestContext;
  let infoSpy: ReturnType<typeof mock>;
  const originalInfo = logger.info;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chatresume" });
    infoSpy = mock(() => {});
    logger.info = infoSpy as unknown as typeof logger.info;
  });

  afterEach(() => {
    logger.info = originalInfo;
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

  async function markerOf(sessionId: string): Promise<string | null> {
    const [row] = await db
      .select({ activeStreamId: chatSessions.activeStreamId })
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);
    return row?.activeStreamId ?? null;
  }

  function resume(sessionId: string) {
    return app.request(`/api/chat/sessions/${sessionId}/stream`, {
      method: "GET",
      headers: authHeaders(ctx),
    });
  }

  const staleClears = () =>
    infoSpy.mock.calls.filter((c) => (c as unknown[])[0] === STALE_MARKER_LOG).length;

  /** Back-date the marker past the stale threshold: the shape a crash leaves. */
  async function ageMarker(sessionId: string): Promise<void> {
    await db
      .update(chatSessions)
      .set({ updatedAt: new Date(Date.now() - STALE_MARKER_MIN_AGE_MS - 1_000) })
      .where(eq(chatSessions.id, sessionId));
  }

  it("clears a marker whose producer is gone, once, and answers 204", async () => {
    const sessionId = await createSession();
    // A stream id no producer ever recorded under, old enough to be stale.
    await setActiveStream(sessionId, "dead");
    await ageMarker(sessionId);
    expect(await markerOf(sessionId)).toBe("dead");

    const first = await resume(sessionId);
    expect(first.status).toBe(204);
    // Negative control: the old route answered 204 and left this set.
    expect(await markerOf(sessionId)).toBeNull();
    expect(staleClears()).toBe(1);

    // Idempotent: the marker is gone, so the second GET never reaches the
    // store, clears nothing, and says nothing.
    const second = await resume(sessionId);
    expect(second.status).toBe(204);
    expect(await markerOf(sessionId)).toBeNull();
    expect(staleClears()).toBe(1);
  });

  it("leaves a freshly claimed marker alone — the store may simply not be acquired yet", async () => {
    const sessionId = await createSession();
    // The shape of a LIVE turn a few milliseconds after `claimTurn`: the marker
    // is written (with a fresh `updated_at`) but `context.run()` has not landed
    // yet, so the store has no recording either. Indistinguishable from a
    // crash except by age — and this one is young.
    await setActiveStream(sessionId, "just-claimed");

    const res = await resume(sessionId);
    expect(res.status).toBe(204);
    // Negative control: without the age guard this marker is wiped and the
    // live turn's own resume answers 204 for the rest of its life.
    expect(await markerOf(sessionId)).toBe("just-claimed");
    expect(staleClears()).toBe(0);
  });

  it("is silent on a session that was never generating", async () => {
    const sessionId = await createSession();
    expect((await resume(sessionId)).status).toBe(204);
    expect(staleClears()).toBe(0);
  });

  it("sweepStaleActiveStreams() nulls every marker and reports how many", async () => {
    const a = await createSession();
    const b = await createSession();
    const idle = await createSession();
    await setActiveStream(a, "dead-a");
    await setActiveStream(b, "dead-b");

    expect(await sweepStaleActiveStreams()).toBe(2);
    expect(await markerOf(a)).toBeNull();
    expect(await markerOf(b)).toBeNull();
    expect(await markerOf(idle)).toBeNull();
    // Nothing left to sweep.
    expect(await sweepStaleActiveStreams()).toBe(0);
  });

  it("init() sweeps on the in-memory tier and NOT on the Redis tier", async () => {
    const sessionId = await createSession();
    await setActiveStream(sessionId, "dead-boot");
    const base = buildModuleInitContext();
    try {
      // Redis configured: another replica may own this turn. Hands off.
      await chatModule.init?.({ ...base, redisUrl: DEAD_REDIS });
      expect(await markerOf(sessionId)).toBe("dead-boot");

      // No Redis: single replica, no recording survived — stale by construction.
      await chatModule.init?.({ ...base, redisUrl: null });
      expect(await markerOf(sessionId)).toBeNull();
      const bootSweeps = infoSpy.mock.calls.filter(
        (c) => (c as unknown[])[0] === "chat: cleared stale active stream markers at boot",
      );
      expect(bootSweeps).toHaveLength(1);
      expect((bootSweeps[0] as unknown[])[1]).toEqual({ count: 1 });
    } finally {
      // Back to the tier the rest of the run expects (the store is a
      // process-wide singleton; `closeResumableStore` disarms the url too).
      await closeResumableStore();
    }
  });
});
