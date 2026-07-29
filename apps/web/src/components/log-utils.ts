// SPDX-License-Identifier: Apache-2.0

// Log types and pure utility functions shared between log-viewer components and pages.

export interface LogEntry {
  message: string;
  type: string;
  level?: string;
  detail?: string;
  /**
   * Wall time of a tool call, in milliseconds, when the runner could pair the
   * call's start and end (`data.durationMs`). Omitted otherwise — the runner
   * deliberately emits nothing rather than a misleading zero.
   *
   * NOTE: whether this survives a live SSE frame depends on the stream, not on
   * the field. `stripPayload` (`apps/api/src/routes/realtime.ts`) drops
   * `run_log.data` only for NON-verbose subscribers — the org-wide
   * `use-global-run-sync` stream, which deliberately omits `verbose` because it
   * discards log payloads anyway. The per-run stream that feeds this projection
   * opens with `verbose=true` (`use-realtime.ts`), so its frames arrive with
   * `data` intact and this materializes live, not only on the REST logs query.
   */
  durationMs?: number;
  createdAt?: Date | string | null;
}

/**
 * One settled assistant turn, projected from a `data.event === "turn"` run-log
 * row (emitted by `buildTurnProgress` in `@appstrate/afps-runtime`).
 *
 * `contextTokens` is the prompt the provider actually saw that turn
 * (`inputTokens + cacheReadTokens + cacheWriteTokens`, output excluded) — the
 * number that reveals where a run started re-reading its whole context.
 */
export interface RunTurnRow {
  index: number;
  contextTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Omitted when the runner could not observe the turn's start. */
  latencyMs?: number;
  /**
   * The window `contextTokens` is a share of, as stated by the runner for THIS
   * turn — the denominator of the whole context reading.
   *
   * It rides the breadcrumb rather than the run row because the runner is the
   * only authority on it: it applies the container-side default the platform
   * cannot see, and it is where the number exists at emission time. Omitted
   * when the runner cannot state it, and absent on every run predating the
   * field — never zero, never a fabricated default.
   */
  contextWindow?: number;
  /**
   * Auto-compaction trigger point for this turn, when the runner has one.
   *
   * Genuinely optional: a runner with auto-compaction disabled now reports that
   * truthfully by omitting the key, which is not the same statement as `0`.
   */
  compactionThreshold?: number;
}

/** `data.event` discriminator carried by per-turn breadcrumb rows. */
const TURN_EVENT = "turn";

function isTurnRow(log: RawLog): boolean {
  return !!log.data && log.data["event"] === TURN_EVENT;
}

/** Read a finite number, or fall back — tolerates malformed/absent payloads. */
function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Project the raw run logs into the per-turn breakdown rendered by the run
 * Info tab. Pure and total: rows that are not turn breadcrumbs, or whose
 * payload is malformed/absent, are skipped rather than throwing.
 *
 * Runs that predate the breadcrumb emit no such rows at all — an empty array
 * is the normal case, and the caller renders nothing for it.
 */
export function buildTurnRows(rawLogs: RawLog[]): RunTurnRow[] {
  const rows: RunTurnRow[] = [];
  for (const log of rawLogs) {
    if (!isTurnRow(log)) continue;
    const d = log.data!;
    // `index` is the row's identity — without it there is nothing to plot.
    if (typeof d["index"] !== "number" || !Number.isFinite(d["index"])) continue;

    const inputTokens = readNumber(d["inputTokens"], 0);
    const outputTokens = readNumber(d["outputTokens"], 0);
    const cacheReadTokens = readNumber(d["cacheReadTokens"], 0);
    const cacheWriteTokens = readNumber(d["cacheWriteTokens"], 0);
    const latencyMs = d["latencyMs"];
    // Same rule as `latencyMs`, and deliberately NOT `readNumber`: these three
    // have no honest fallback. A missing window is "unknown", which the reading
    // must be able to tell apart from any number at all — so the key is left
    // ABSENT rather than defaulted, and a malformed payload drops it the same
    // way instead of throwing.
    const contextWindow = d["contextWindow"];
    const compactionThreshold = d["compactionThreshold"];

    rows.push({
      index: d["index"],
      // The emitter computes `contextTokens`; recompute only as a fallback so a
      // row written by an older/partial emitter still plots the right bar.
      contextTokens: readNumber(
        d["contextTokens"],
        inputTokens + cacheReadTokens + cacheWriteTokens,
      ),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(typeof latencyMs === "number" && Number.isFinite(latencyMs) ? { latencyMs } : {}),
      ...(typeof contextWindow === "number" && Number.isFinite(contextWindow)
        ? { contextWindow }
        : {}),
      ...(typeof compactionThreshold === "number" && Number.isFinite(compactionThreshold)
        ? { compactionThreshold }
        : {}),
    });
  }
  return rows;
}

export interface RawLog {
  type: string;
  level: string;
  event?: string | null;
  message?: string | null;
  data?: Record<string, unknown> | null;
  createdAt?: Date | string | null;
}

function formatToolArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const str = typeof value === "string" ? value : JSON.stringify(value);
    parts.push(`${key}: ${str}`);
  }
  const joined = parts.join(", ");
  return joined.length > 200 ? joined.slice(0, 200) + "..." : joined;
}

/**
 * Transform raw run logs into LogEntry[], merging consecutive text-only
 * progress entries and extracting the structured output.
 */
export function buildLogEntries(rawLogs: RawLog[]): {
  entries: LogEntry[];
  output: Record<string, unknown> | null;
} {
  const entries: LogEntry[] = [];
  let output: Record<string, unknown> | null = null;
  let lastWasPlainText = false;

  for (const log of rawLogs) {
    if (log.event === "output" && log.data) {
      if (!output) output = {};
      Object.assign(output, log.data);
      lastWasPlainText = false;
    } else if (log.event === "report" && log.type === "result") {
      // Dead channel: the `report` runtime tool was replaced by durable
      // `outputs/` documents. Rows written before the removal stay in the DB
      // but are skipped here — falling through to the generic branch would
      // render them as a truncated, contextless log line.
      lastWasPlainText = false;
    } else if (log.event === "run_completed") {
      lastWasPlainText = false;
    } else if (isTurnRow(log)) {
      // Per-turn breadcrumbs are a structured series, not narration: a heavy
      // run emits ~108 of them and they would drown the agent's own log lines.
      // They are rendered as a table in the run Info tab (`buildTurnRows`).
      // Same precedent as the dead `report` channel above.
      lastWasPlainText = false;
    } else {
      const logData = log.data ?? {};
      const message = (logData.message as string) || log.message || "";
      if (message) {
        const args = logData.args as Record<string, unknown> | undefined;
        const detail = args ? formatToolArgs(args) : undefined;
        const durationMs = logData["durationMs"];
        const isPlainText = log.type === "progress" && !log.data;

        if (isPlainText && lastWasPlainText && entries.length > 0) {
          entries[entries.length - 1]!.message += "\n" + message;
        } else {
          entries.push({
            message,
            type: log.type || "progress",
            level: log.level || "debug",
            detail,
            ...(typeof durationMs === "number" && Number.isFinite(durationMs)
              ? { durationMs }
              : {}),
            createdAt: log.createdAt,
          });
        }
        lastWasPlainText = isPlainText;
      }
    }
  }

  return { entries, output };
}

export function formatTimestamp(d: Date | string | null | undefined, lang: string): string {
  if (!d) return "\u2014";
  try {
    const date = d instanceof Date ? d : new Date(d);
    const ms = String(date.getMilliseconds()).padStart(3, "0");
    const hms = date.toLocaleTimeString(lang, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    return `${hms}.${ms}`;
  } catch {
    return "\u2014";
  }
}

/** Text color by semantic type (nature of the log). */
export const typeColors: Record<string, string> = {
  system: "text-primary",
};

/** Text color by severity level (overrides type color when set). */
export const levelColors: Record<string, string> = {
  warn: "text-amber-400",
  error: "text-destructive",
};
