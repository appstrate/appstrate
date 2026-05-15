// SPDX-License-Identifier: Apache-2.0

import type { RunEvent } from "@appstrate/afps-runtime/types";
import type { EventBuffer, BufferedEvent } from "./interface.ts";

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
  }

  async put(runId: string, sequence: number, event: RunEvent, ttlSeconds: number): Promise<void> {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const entry: Entry = { sequence, event, expiresAt };
    const existing = this.buffers.get(runId);
    if (!existing) {
      this.buffers.set(runId, [entry]);
      return;
    }
    // Replace any entry with the same sequence (replay safety), then insert
    // in sorted order so peekLowest is O(1).
    const filtered = existing.filter((e) => e.sequence !== sequence);
    const insertIdx = filtered.findIndex((e) => e.sequence > sequence);
    if (insertIdx === -1) filtered.push(entry);
    else filtered.splice(insertIdx, 0, entry);
    this.buffers.set(runId, filtered);
  }

  async peekLowest(runId: string): Promise<BufferedEvent | null> {
    const entries = this.buffers.get(runId);
    if (!entries || entries.length === 0) return null;
    const now = Date.now();
    // Drop expired head entries before peeking.
    while (entries.length > 0 && entries[0]!.expiresAt <= now) {
      entries.shift();
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

  async debugList(runId: string): Promise<number[]> {
    return (this.buffers.get(runId) ?? []).map((e) => e.sequence);
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [runId, entries] of this.buffers) {
      const keep = entries.filter((e) => e.expiresAt > now);
      if (keep.length === 0) this.buffers.delete(runId);
      else if (keep.length !== entries.length) this.buffers.set(runId, keep);
    }
  }
}
