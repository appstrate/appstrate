// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { HistoryEntry, MemorySnapshot } from "../types/execution-context.ts";

/**
 * Source of the pull-side runtime context: past memories, previous
 * state, run history, and dynamically fetched resources.
 *
 * The runtime uses this interface to populate the `context.json` shape
 * before rendering the prompt template (see
 * `AFPS_EXTENSION_ARCHITECTURE.md` §3.3 "push and pull"). The same
 * interface is also consumed at runtime by a `resourceLoader` bridge
 * when an agent requests dynamically fetched documents
 * (`resourceLoader` is the `Pi SDK` concept — see §3.4).
 *
 * Bundled implementations:
 *
 * - `AppstrateContextProvider` — HTTP to the Appstrate platform API
 * - `FileContextProvider` — event-sourced from `run-*.jsonl` files
 *   produced by {@link FileSink}
 * - `NoopContextProvider` — returns empty for everything (stateless)
 * - `SnapshotContextProvider` — reads a single pre-captured snapshot
 *
 * Implementations MUST return promises even when the data is locally
 * available, to keep the interface uniform across sync and async
 * backends.
 */
export interface ContextProvider {
  /**
   * Past memories written by previous runs. Returned in reverse
   * chronological order by default (most recent first). Callers may
   * scope via `limit` (max entries) or `since` (Unix ms threshold).
   */
  getMemories(opts?: GetMemoriesOptions): Promise<MemorySnapshot[]>;

  /**
   * Past run summaries — each entry contains the output of a previous
   * run of the same agent. Used to give the agent awareness of its own
   * recent behavior.
   */
  getHistory(opts?: GetHistoryOptions): Promise<HistoryEntry[]>;

  /**
   * Last persisted state set via `set_state`. Returns `null` if no
   * state exists.
   */
  getState(): Promise<unknown | null>;

  /**
   * Optional: fetch a resource by URI for the `resourceLoader` bridge.
   * Implementations SHOULD return content and a MIME type; returning
   * `undefined` signals "not found" distinctly from throwing.
   */
  getResource?(uri: string): Promise<ResourceContent | undefined>;
}

export interface GetMemoriesOptions {
  limit?: number;
  since?: number;
}

export interface GetHistoryOptions {
  limit?: number;
}

export interface ResourceContent {
  content: string;
  mimeType: string;
}
