// SPDX-License-Identifier: Apache-2.0

/**
 * Read the results of the two first-party runtime tools a run can call,
 * `recall_memory` and `run_history`, so the journal can list them instead of
 * printing JSON. Both answer through the sidecar as an MCP text part holding
 * the platform's JSON (`GET /internal/memories` → `{ memories }`,
 * `GET /internal/run-history` → a `{ data }` list envelope); a result logged
 * already parsed, or as a bare string, reads the same.
 *
 * `null` means "not a shape this knows", and the caller keeps the raw JSON.
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
