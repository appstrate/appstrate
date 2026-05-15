// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for {@link LocalEventBuffer}.
 *
 * The in-memory implementation exists so Tier 0 / Tier 1 deployments
 * (no Redis) can run the HttpSink ingestion path without crashing.
 * Before this buffer existed, every event POST would call
 * `getRedisConnection()` which throws when `REDIS_URL` is absent —
 * silently stalling every run at status="running" in dev mode.
 */

import { describe, it, expect } from "bun:test";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import { LocalEventBuffer } from "../../../src/infra/event-buffer/local-event-buffer.ts";
import { RedisEventBuffer } from "../../../src/infra/event-buffer/redis-event-buffer.ts";

function mkEvent(seq: number): RunEvent {
  return {
    type: "appstrate.progress",
    timestamp: seq,
    runId: "r",
    message: `event-${seq}`,
  };
}

describe("LocalEventBuffer", () => {
  it("peekLowest returns null on an empty buffer", async () => {
    const buf = new LocalEventBuffer();
    expect(await buf.peekLowest("r1")).toBeNull();
    await buf.shutdown();
  });

  it("returns the lowest-sequence entry first, regardless of insert order", async () => {
    const buf = new LocalEventBuffer();
    await buf.put("r1", 5, mkEvent(5), 60);
    await buf.put("r1", 3, mkEvent(3), 60);
    await buf.put("r1", 7, mkEvent(7), 60);

    const first = await buf.peekLowest("r1");
    expect(first?.sequence).toBe(3);
    await buf.remove("r1", 3);

    const next = await buf.peekLowest("r1");
    expect(next?.sequence).toBe(5);
    await buf.shutdown();
  });

  it("remove is idempotent — removing a non-existent sequence is a no-op", async () => {
    const buf = new LocalEventBuffer();
    await buf.put("r1", 1, mkEvent(1), 60);
    await buf.remove("r1", 99);
    const head = await buf.peekLowest("r1");
    expect(head?.sequence).toBe(1);
    await buf.shutdown();
  });

  it("replaces the entry at the same sequence (replay safety)", async () => {
    const buf = new LocalEventBuffer();
    const original: RunEvent = mkEvent(1);
    const replacement: RunEvent = {
      type: "appstrate.progress",
      timestamp: 999,
      runId: "r",
      message: "replacement",
    };
    await buf.put("r1", 1, original, 60);
    await buf.put("r1", 1, replacement, 60);

    const head = await buf.peekLowest("r1");
    expect(head?.sequence).toBe(1);
    expect((head?.event as unknown as { message: string }).message).toBe("replacement");
    await buf.shutdown();
  });

  it("clear drops every pending event for a run and leaves others untouched", async () => {
    const buf = new LocalEventBuffer();
    await buf.put("r1", 1, mkEvent(1), 60);
    await buf.put("r1", 2, mkEvent(2), 60);
    await buf.put("r2", 1, mkEvent(10), 60);

    await buf.clear("r1");

    expect(await buf.peekLowest("r1")).toBeNull();
    expect((await buf.peekLowest("r2"))?.sequence).toBe(1);
    await buf.shutdown();
  });

  it("expired entries at the head are dropped on peek", async () => {
    const buf = new LocalEventBuffer();
    // TTL = 0 → immediately expired.
    await buf.put("r1", 1, mkEvent(1), 0);
    // Wait one tick to cross the Date.now() boundary.
    await new Promise((r) => setTimeout(r, 5));
    const head = await buf.peekLowest("r1");
    expect(head).toBeNull();
    await buf.shutdown();
  });

  it("expired head + live tail — peek surfaces the live entry", async () => {
    const buf = new LocalEventBuffer();
    await buf.put("r1", 1, mkEvent(1), 0); // immediately expired
    await buf.put("r1", 2, mkEvent(2), 60);
    await new Promise((r) => setTimeout(r, 5));

    const head = await buf.peekLowest("r1");
    expect(head?.sequence).toBe(2);
    await buf.shutdown();
  });

  it("drain-style walk: peek + remove in loop yields events in sequence order", async () => {
    const buf = new LocalEventBuffer();
    await buf.put("r1", 2, mkEvent(2), 60);
    await buf.put("r1", 1, mkEvent(1), 60);
    await buf.put("r1", 4, mkEvent(4), 60);
    await buf.put("r1", 3, mkEvent(3), 60);

    const drained: number[] = [];
    for (;;) {
      const head = await buf.peekLowest("r1");
      if (!head) break;
      drained.push(head.sequence);
      await buf.remove("r1", head.sequence);
    }

    expect(drained).toEqual([1, 2, 3, 4]);
    await buf.shutdown();
  });

  it("per-run isolation — r1 and r2 buffers never cross", async () => {
    const buf = new LocalEventBuffer();
    await buf.put("r1", 1, mkEvent(1), 60);
    await buf.put("r2", 1, mkEvent(100), 60);

    const h1 = await buf.peekLowest("r1");
    const h2 = await buf.peekLowest("r2");
    expect((h1?.event as unknown as { message: string }).message).toBe("event-1");
    expect((h2?.event as unknown as { message: string }).message).toBe("event-100");
    await buf.shutdown();
  });
});

describe("RedisEventBuffer", () => {
  // Regression: the runner can emit multiple events whose
  // `JSON.stringify(event)` collapses to the same string — e.g. 10 parallel
  // `provider.called` events that complete in the same millisecond with
  // identical providerId/method/target/status/durationMs and a
  // `toolCallId: undefined` field that JSON drops. In a Redis sorted set,
  // ZADD with an existing member updates the score instead of inserting a
  // new entry, so all 10 would collapse into one entry and 9 sequences
  // would silently disappear from the buffer (then re-surface only via
  // finalize's gap_fill, clustered at the close timestamp).
  //
  // The fix prefixes each member with its sequence so member identity is
  // sequence-keyed regardless of payload.
  it("preserves every sequence even when JSON.stringify(event) collides", async () => {
    const runId = `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const buf = new RedisEventBuffer();
    try {
      const identical: RunEvent = {
        type: "provider.called",
        runId,
        timestamp: 1700000000000,
        providerId: "@appstrate/gmail",
        method: "GET",
        target: "https://www.googleapis.com/gmail/v1/users/me/messages",
        status: 200,
        durationMs: 0,
      };

      for (let seq = 10; seq <= 19; seq++) {
        await buf.put(runId, seq, identical, 60);
      }

      const drained: number[] = [];
      while (true) {
        const head = await buf.peekLowest(runId);
        if (!head) break;
        drained.push(head.sequence);
        await buf.remove(runId, head.sequence);
      }

      expect(drained).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    } finally {
      await buf.clear(runId);
      await buf.shutdown();
    }
  });
});
