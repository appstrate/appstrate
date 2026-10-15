// SPDX-License-Identifier: Apache-2.0

/**
 * Reads the results of `recall_memory` and `run_history` (an MCP text part holding
 * `{ memories }` / a `{ data }` envelope; an already-parsed or bare-string result
 * reads the same). `null` = unknown shape, the caller keeps the raw JSON.
 */

import { asRecordOrNull } from "@appstrate/core/safe-json";
import { unwrapMcpResult } from "@appstrate/core/mcp-result";

export interface RecalledMemory {
  id: string;
  content: string;
  createdAt?: string;
}

export interface HistoryRun {
  id: string;
  status?: string;
  date?: string;
  duration?: number;
}

const str = (value: unknown) => (typeof value === "string" ? value : undefined);

export function recalledMemories(result: unknown): RecalledMemory[] | null {
  const memories = asRecordOrNull(unwrapMcpResult(result))?.memories;
  if (!Array.isArray(memories)) return null;
  return memories.flatMap((raw) => {
    const memory = asRecordOrNull(raw);
    if (!memory || typeof memory.content !== "string") return [];
    return [{ id: String(memory.id), content: memory.content, createdAt: str(memory.createdAt) }];
  });
}

export function historyRuns(result: unknown): HistoryRun[] | null {
  const runs = asRecordOrNull(unwrapMcpResult(result))?.data;
  if (!Array.isArray(runs)) return null;
  return runs.flatMap((raw) => {
    const run = asRecordOrNull(raw);
    if (!run || typeof run.id !== "string") return [];
    return [
      {
        id: run.id,
        status: str(run.status),
        date: str(run.date),
        duration: typeof run.duration === "number" ? run.duration : undefined,
      },
    ];
  });
}
