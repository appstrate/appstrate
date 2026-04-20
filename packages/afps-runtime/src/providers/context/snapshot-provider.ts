// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type {
  ContextProvider,
  GetMemoriesOptions,
  GetHistoryOptions,
  ResourceContent,
} from "../../interfaces/context-provider.ts";
import type { HistoryEntry, MemorySnapshot } from "../../types/execution-context.ts";

export interface ContextSnapshot {
  memories?: MemorySnapshot[];
  history?: HistoryEntry[];
  state?: unknown;
  resources?: Record<string, ResourceContent>;
}

/**
 * {@link ContextProvider} that serves a single pre-captured snapshot.
 *
 * Used when a bundle ships alongside a `context.json` that already
 * contains the memories/state/history to inject — typically for:
 *
 * - Reproducing a recorded run exactly
 * - Offline evaluation (e.g. golden-output tests)
 * - Instances where the server-side Appstrate API is unreachable
 *
 * `limit` and `since` options are honored; `history.limit` truncates
 * from the head (most recent first) per the interface contract.
 *
 * Specification: see `AFPS_EXTENSION_ARCHITECTURE.md` §3.3.
 */
export class SnapshotContextProvider implements ContextProvider {
  private readonly snapshot: Required<
    Pick<ContextSnapshot, "memories" | "history" | "resources">
  > & {
    state: unknown;
  };

  constructor(snapshot: ContextSnapshot = {}) {
    this.snapshot = {
      memories: snapshot.memories ?? [],
      history: snapshot.history ?? [],
      state: snapshot.state ?? null,
      resources: snapshot.resources ?? {},
    };
  }

  async getMemories(opts?: GetMemoriesOptions): Promise<MemorySnapshot[]> {
    let out = this.snapshot.memories;
    if (opts?.since !== undefined) {
      const threshold = opts.since;
      out = out.filter((m) => m.createdAt >= threshold);
    }
    if (opts?.limit !== undefined && opts.limit >= 0) {
      out = out.slice(0, opts.limit);
    }
    return out;
  }

  async getHistory(opts?: GetHistoryOptions): Promise<HistoryEntry[]> {
    const all = this.snapshot.history;
    if (opts?.limit !== undefined && opts.limit >= 0) {
      return all.slice(0, opts.limit);
    }
    return all;
  }

  async getState(): Promise<unknown | null> {
    return this.snapshot.state ?? null;
  }

  async getResource(uri: string): Promise<ResourceContent | undefined> {
    return this.snapshot.resources[uri];
  }
}
