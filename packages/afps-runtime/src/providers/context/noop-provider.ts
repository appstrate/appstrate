// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type {
  ContextProvider,
  GetMemoriesOptions,
  GetHistoryOptions,
  ResourceContent,
} from "../../interfaces/context-provider.ts";
import type { HistoryEntry, MemorySnapshot } from "../../types/execution-context.ts";

/**
 * Stateless {@link ContextProvider} — returns empty results for every
 * lookup. Appropriate for:
 *
 * - First-run bundles with no prior state to inject
 * - Reproducibility checks where context-dependence must be removed
 * - Stateless agents (set_state/add_memory never called)
 *
 * Specification: see `AFPS_EXTENSION_ARCHITECTURE.md` §3.3.
 */
export class NoopContextProvider implements ContextProvider {
  async getMemories(_opts?: GetMemoriesOptions): Promise<MemorySnapshot[]> {
    return [];
  }

  async getHistory(_opts?: GetHistoryOptions): Promise<HistoryEntry[]> {
    return [];
  }

  async getState(): Promise<unknown | null> {
    return null;
  }

  async getResource(_uri: string): Promise<ResourceContent | undefined> {
    return undefined;
  }
}
