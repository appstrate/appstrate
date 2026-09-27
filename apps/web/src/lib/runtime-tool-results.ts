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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The JSON payload behind an MCP content array, a JSON string, or a plain object. */
function payload(result: unknown): unknown {
  if (typeof result === "string") {
    try {
      return JSON.parse(result);
    } catch {
      return null;
    }
  }
  const content = record(result)?.content ?? (Array.isArray(result) ? result : null);
  if (Array.isArray(content)) {
    const text = content.find(
      (part) => record(part)?.type === "text" && typeof record(part)?.text === "string",
    );
    return text ? payload((text as { text: string }).text) : null;
  }
  return result;
}

const str = (value: unknown) => (typeof value === "string" ? value : undefined);

export function recalledMemories(result: unknown): RecalledMemory[] | null {
  const memories = record(payload(result))?.memories;
  if (!Array.isArray(memories)) return null;
  return memories.flatMap((raw) => {
    const memory = record(raw);
    if (!memory || typeof memory.content !== "string") return [];
    return [{ id: String(memory.id), content: memory.content, createdAt: str(memory.createdAt) }];
  });
}

export function historyRuns(result: unknown): HistoryRun[] | null {
  const runs = record(payload(result))?.data;
  if (!Array.isArray(runs)) return null;
  return runs.flatMap((raw) => {
    const run = record(raw);
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
