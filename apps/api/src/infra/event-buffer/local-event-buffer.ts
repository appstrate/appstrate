// SPDX-License-Identifier: Apache-2.0

import type { RunEvent } from "@appstrate/afps-runtime/types";
import { logger } from "../../lib/logger.ts";
import { MAX_BUFFER_ENTRIES, type EventBuffer, type BufferedEvent } from "./interface.ts";

interface Entry {
  sequence: number;
  event: RunEvent;
  expiresAt: number;
}

/**
 * In-memory ordering buffer. Single-instance only — for Tier 0/1 deployments
 * where every HttpSink POST hits the same Node process, so cross-instance
 * consistency is not a concern. Expired entries are purged lazily on access
 * + on a 60s background sweep.
 */
export class LocalEventBuffer implements EventBuffer {
  private buffers = new Map<string, Entry[]>();
  private purgeInterval: ReturnType<typeof setInterval>;

  constructor() {
    this.purgeInterval = setInterval(() => this.purgeExpired(), 60_000);
    // Don't keep the event loop alive on the timer alone (clean test exit;
    // no effect in prod where the server listener holds the loop open).
    this.purgeInterval.unref?.();
  }

  async put(runId: string, sequence: number, event: RunEvent, ttlSeconds: number): Promise<void> {
    const entry: Entry = { sequence, event, expiresAt: Date.now() + ttlSeconds * 1000 };
    const entries = this.buffers.get(runId);
    if (!entries) {
      this.buffers.set(runId, [entry]);
      return;
    }
    // The array is kept sorted by sequence, so binary-search the insert point:
    // an entry already at that sequence is replaced in place (replay safety),
    // anything else is spliced in. Keeps peekLowest O(1).
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (entries[mid]!.sequence < sequence) lo = mid + 1;
      else hi = mid;
    }
    if (entries[lo]?.sequence === sequence) entries[lo] = entry;
    else entries.splice(lo, 0, entry);

    // Same overflow policy as the Redis backend's ZREMRANGEBYRANK: drop the
    // lowest sequences (stale, waiting on a gap the runner never filled).
    if (entries.length > MAX_BUFFER_ENTRIES) {
      const trimmed = entries.length - MAX_BUFFER_ENTRIES;
      entries.splice(0, trimmed);
      logger.warn("event buffer overflowed — dropped oldest entries", {
        runId,
        trimmed,
        cap: MAX_BUFFER_ENTRIES,
      });
    }
  }

  async peekLowest(runId: string): Promise<BufferedEvent | null> {
    const entries = this.buffers.get(runId);
    if (!entries || entries.length === 0) return null;
    const now = Date.now();
    // Drop expired head entries before peeking.
    let dropped = 0;
    while (dropped < entries.length && entries[dropped]!.expiresAt <= now) dropped++;
    if (dropped > 0) {
      entries.splice(0, dropped);
      this.logExpiredDrop(runId, dropped);
    }
    if (entries.length === 0) {
      this.buffers.delete(runId);
      return null;
    }
    const head = entries[0]!;
    return { sequence: head.sequence, event: head.event };
  }

  async remove(runId: string, sequence: number): Promise<void> {
    const entries = this.buffers.get(runId);
    if (!entries) return;
    const idx = entries.findIndex((e) => e.sequence === sequence);
    if (idx === -1) return;
    entries.splice(idx, 1);
    if (entries.length === 0) this.buffers.delete(runId);
  }

  async clear(runId: string): Promise<void> {
    this.buffers.delete(runId);
  }

  async shutdown(): Promise<void> {
    clearInterval(this.purgeInterval);
    this.buffers.clear();
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [runId, entries] of this.buffers) {
      const keep = entries.filter((e) => e.expiresAt > now);
      const dropped = entries.length - keep.length;
      if (dropped === 0) continue;
      if (keep.length === 0) this.buffers.delete(runId);
      else this.buffers.set(runId, keep);
      this.logExpiredDrop(runId, dropped);
    }
  }

  private logExpiredDrop(runId: string, dropped: number): void {
    logger.warn("event buffer dropped expired entries", { runId, dropped });
  }
}
