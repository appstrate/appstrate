// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate-backed {@link ContextProvider} — exposes the platform's
 * memories/state/history tables through the runtime's pull-side
 * interface. Consumed internally by `apps/api` the same way an external
 * runtime consumer would consume `FileContextProvider` or
 * `SnapshotContextProvider`: the runtime does not know (and does not
 * need to know) that the backing store is PostgreSQL.
 *
 * DB shapes are normalised at this boundary:
 *   - `createdAt` → Unix epoch ms (runtime contract — `PromptView` and
 *     `MemorySnapshot` use numeric timestamps)
 *   - `runs.state` → passed through as-is (unknown, validated by the
 *     caller if a shape is expected)
 *
 * See docs/architecture/AFPS_EXTENSION_ARCHITECTURE.md §3 for the
 * pull-side contract.
 */

import type {
  ContextProvider,
  GetHistoryOptions,
  GetMemoriesOptions,
} from "@appstrate/afps-runtime/interfaces";
import type { HistoryEntry, MemorySnapshot } from "@appstrate/afps-runtime/types";
import { getPackageMemories } from "../state/package-memories.ts";
import { getLastRunState, getRecentRuns } from "../state/runs.ts";
import type { Actor } from "../../lib/actor.ts";

export interface AppstrateContextScope {
  orgId: string;
  applicationId: string;
  packageId: string;
  /** Actor scoping (end-user vs dashboard). `null` = no actor filter. */
  actor: Actor | null;
  /** Exclude this run from history (typically the currently-running one). */
  excludeRunId?: string;
}

export class AppstrateContextProvider implements ContextProvider {
  constructor(private readonly scope: AppstrateContextScope) {}

  async getMemories(opts: GetMemoriesOptions = {}): Promise<MemorySnapshot[]> {
    const rows = await getPackageMemories(this.scope.packageId, this.scope.applicationId);

    // Rows arrive in ascending createdAt order — reverse to match the
    // interface contract "most recent first".
    const reversed = [...rows].reverse();

    const sinceMs = opts.since;
    const filtered =
      sinceMs !== undefined ? reversed.filter((r) => toEpochMs(r.createdAt) >= sinceMs) : reversed;

    const limited = opts.limit !== undefined ? filtered.slice(0, opts.limit) : filtered;

    return limited.map((m) => ({
      content: m.content,
      createdAt: toEpochMs(m.createdAt),
    }));
  }

  async getState(): Promise<unknown | null> {
    return getLastRunState(
      { orgId: this.scope.orgId, applicationId: this.scope.applicationId },
      this.scope.packageId,
      this.scope.actor,
    );
  }

  async getHistory(opts: GetHistoryOptions = {}): Promise<HistoryEntry[]> {
    const rows = await getRecentRuns(
      { orgId: this.scope.orgId, applicationId: this.scope.applicationId },
      this.scope.packageId,
      this.scope.actor,
      {
        limit: opts.limit,
        fields: ["state", "result"],
        excludeRunId: this.scope.excludeRunId,
      },
    );

    return rows.map((row) => ({
      runId: String(row.id ?? ""),
      timestamp: parseISODate(row.date),
      output: row.result ?? row.state ?? null,
    }));
  }
}

function toEpochMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

function parseISODate(value: unknown): number {
  if (typeof value !== "string") return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}
