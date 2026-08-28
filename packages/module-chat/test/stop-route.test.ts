// SPDX-License-Identifier: Apache-2.0

/**
 * The stop button, end to end on the server side.
 *
 * `stop-registry.test.ts` proves the registry aborts the controller it was
 * handed. Nothing proved the JOIN: that `POST /api/chat/sessions/:id/stop`
 * resolves the session's `active_stream_id` and hands THAT id to the registry.
 * The two halves can each be perfect while the route stops nothing — the
 * client gets its 204, the spinner clears, and generation runs on, billing
 * tokens (the #1170 regression). No test posted this route.
 *
 * The registry is used for real here rather than injected: it is process-local
 * module state, and the whole point is that the route reaches the same
 * instance the streaming producer registered into.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { setActiveStream } from "../src/resumable.ts";
import { registerStopController, unregisterStopController } from "../src/stop-registry.ts";

const app = getTestApp();

describe("POST /api/chat/sessions/:id/stop", () => {
  let ctx: TestContext;
  const registered: string[] = [];

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chatstop" });
  });

  afterEach(() => {
    // The registry is module state, not DB state — `truncateAll` cannot reach it.
    for (const id of registered.splice(0)) unregisterStopController(id);
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

  /** A session with a live producer: stream id marked on the row + registered. */
  async function sessionWithLiveStream(): Promise<{
    sessionId: string;
    controller: AbortController;
  }> {
    const sessionId = await createSession();
    const streamId = `stream_${sessionId}`;
    const controller = new AbortController();
    registerStopController(streamId, controller);
    registered.push(streamId);
    await setActiveStream(sessionId, streamId);
    return { sessionId, controller };
  }

  function stop(sessionId: string) {
    return app.request(`/api/chat/sessions/${sessionId}/stop`, {
      method: "POST",
      headers: authHeaders(ctx),
    });
  }

  it("aborts the generation of the stream the session is running", async () => {
    const { sessionId, controller } = await sessionWithLiveStream();
    expect(controller.signal.aborted).toBe(false);

    const res = await stop(sessionId);
    expect(res.status).toBe(204);
    expect(controller.signal.aborted).toBe(true);
  });

  it("aborts only the named session's stream, not another live one", async () => {
    const a = await sessionWithLiveStream();
    const b = await sessionWithLiveStream();

    expect((await stop(a.sessionId)).status).toBe(204);
    expect(a.controller.signal.aborted).toBe(true);
    // The route resolves the stream id from the session it was given — a stop
    // that reached the registry by any other route (e.g. the session id, or
    // "whatever is live") would take this one down too.
    expect(b.controller.signal.aborted).toBe(false);
  });

  it("is a quiet no-op on a session with no turn in flight", async () => {
    // Control: a session that never streamed has no `active_stream_id`. It
    // must answer 204 without reaching into the registry at all.
    const idle = await createSession();
    const live = await sessionWithLiveStream();

    expect((await stop(idle)).status).toBe(204);
    expect(live.controller.signal.aborted).toBe(false);
  });
});
