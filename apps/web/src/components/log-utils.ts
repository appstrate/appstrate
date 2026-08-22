// SPDX-License-Identifier: Apache-2.0

// Execution-trace types and pure projection functions shared between the run
// page and its viewer. Persisted `run_logs` stay append-only; this module owns
// the richer, correlated shape the UI renders.

interface ExecutionEntryBase {
  /** Stable across live start -> result updates and historical replay. */
  id: string;
  kind: "agent" | "tool" | "log" | "runtime";
  level?: string;
  createdAt?: Date | string | null;
}

interface AgentExecutionEntry extends ExecutionEntryBase {
  kind: "agent";
  message: string;
  level: "debug";
}

export type ToolExecutionStatus = "running" | "success" | "failed" | "interrupted" | "unknown";

export interface ToolExecutionEntry extends ExecutionEntryBase {
  kind: "tool";
  tool: string;
  toolCallId?: string;
  status: ToolExecutionStatus;
  args?: unknown;
  result?: unknown;
  detail?: string;
  /** True when a result arrived without a matching start row. */
  orphaned?: boolean;
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
  completedAt?: Date | string | null;
}

interface ExplicitLogExecutionEntry extends ExecutionEntryBase {
  kind: "log";
  message: string;
}

interface RuntimeExecutionEntry extends ExecutionEntryBase {
  kind: "runtime";
  message: string;
  sourceType: string;
}

export type ExecutionEntry =
  AgentExecutionEntry | ToolExecutionEntry | ExplicitLogExecutionEntry | RuntimeExecutionEntry;

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
    // Same rule as `latencyMs`, and deliberately NOT `readNumber`: neither has
    // an honest fallback. A missing window is "unknown", which the reading must
    // be able to tell apart from any number at all — so the key is left ABSENT
    // rather than defaulted, and a malformed payload drops it the same way
    // instead of throwing.
    const contextWindow = d["contextWindow"];

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
    });
  }
  return rows;
}

export interface RawLog {
  id?: number;
  type: string;
  level: string;
  event?: string | null;
  message?: string | null;
  data?: Record<string, unknown> | null;
  createdAt?: Date | string | null;
}

function formatToolArgs(args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    const str = typeof args === "string" ? args : JSON.stringify(args);
    return (str ?? "").slice(0, 200);
  }

  const parts: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    const str = typeof value === "string" ? value : JSON.stringify(value);
    parts.push(`${key}: ${str}`);
  }
  const joined = parts.join(", ");
  return joined.length > 200 ? joined.slice(0, 200) + "..." : joined;
}

const ASSISTANT_MESSAGE_EVENT = "assistant_message";

function owns(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toolName(data: Record<string, unknown>, message: string): string {
  const explicit = stringValue(data["tool"]);
  if (explicit) return explicit;
  const separator = message.indexOf(":");
  return separator >= 0 ? message.slice(separator + 1).trim() || "unknown" : "unknown";
}

/**
 * Tool starts and results deliberately share the generic `appstrate.progress`
 * envelope. Their payload is the stable discriminator: results always carry
 * `isError`, even when the underlying tool returned `undefined`; starts carry
 * `args` when the SDK supplied them and use the `Tool:` message otherwise.
 */
function toolRowPhase(
  data: Record<string, unknown>,
  message: string,
): "start" | "result" | undefined {
  const looksToolish =
    stringValue(data["tool"]) !== undefined ||
    stringValue(data["toolCallId"]) !== undefined ||
    message.startsWith("Tool:") ||
    message.startsWith("Tool result") ||
    message.startsWith("Tool error");
  if (!looksToolish) return undefined;
  if (typeof data["isError"] === "boolean" || owns(data, "result")) return "result";
  if (owns(data, "args") || message.startsWith("Tool:")) return "start";
  return undefined;
}

function rawEntryId(log: RawLog, index: number, suffix = ""): string {
  return `log:${log.id ?? index}${suffix}`;
}

function isAgentText(log: RawLog): boolean {
  if (log.type !== "progress") return false;
  if (log.data?.["event"] === ASSISTANT_MESSAGE_EVENT) return true;
  // Compatibility with runs emitted before `assistant_message` was stamped.
  return !log.data && log.level === "debug";
}

interface BuildLogEntriesOptions {
  /** Marks correlated starts with no result as interrupted instead of spinning forever. */
  isRunTerminal?: boolean;
}

/**
 * Project raw run logs into a compact execution trace and structured output.
 *
 * Tool starts/results remain separate in persistence but collapse here by
 * exact `toolCallId`. Tool-name matching is intentionally forbidden: parallel
 * calls of the same tool may settle out of order. Legacy rows without an id
 * remain separate and explicitly `unknown` once a run is terminal.
 */
export function buildLogEntries(
  rawLogs: RawLog[],
  options: BuildLogEntriesOptions = {},
): {
  entries: ExecutionEntry[];
  output: Record<string, unknown> | null;
} {
  const entries: ExecutionEntry[] = [];
  const toolEntryByCallId = new Map<string, number>();
  let output: Record<string, unknown> | null = null;

  for (const [rawIndex, log] of rawLogs.entries()) {
    if (log.event === "output" && log.data) {
      if (!output) output = {};
      Object.assign(output, log.data);
    } else if (log.event === "report" && log.type === "result") {
      // Dead channel: the `report` runtime tool was replaced by durable
      // `outputs/` files. Rows written before the removal stay in the DB
      // but are skipped here — falling through to the generic branch would
      // render them as a truncated, contextless log line.
    } else if (log.event === "run_completed") {
      continue;
    } else if (isTurnRow(log)) {
      // Per-turn breadcrumbs are a structured series, not narration: a heavy
      // run emits ~108 of them and they would drown the agent's own log lines.
      // They are rendered as a table in the run Info tab (`buildTurnRows`).
      // Same precedent as the dead `report` channel above.
    } else {
      const logData = log.data ?? {};
      const message = (logData.message as string) || log.message || "";
      if (!message) continue;

      // Explicit semantic channels win over message-shape fallbacks. In
      // particular, agent prose or a log-tool message is allowed to begin
      // with "Tool:" without becoming a synthetic tool invocation.
      if (log.event === "log") {
        entries.push({
          id: rawEntryId(log, rawIndex, ":explicit-log"),
          kind: "log",
          message,
          level: log.level || "info",
          createdAt: log.createdAt,
        });
        continue;
      }

      if (isAgentText(log)) {
        entries.push({
          id: rawEntryId(log, rawIndex, ":agent"),
          kind: "agent",
          message,
          level: "debug",
          createdAt: log.createdAt,
        });
        continue;
      }

      const phase = toolRowPhase(logData, message);
      if (phase) {
        const callId = stringValue(logData["toolCallId"]);
        const name = toolName(logData, message);
        const durationMs = logData["durationMs"];

        if (phase === "start") {
          const existingIndex = callId ? toolEntryByCallId.get(callId) : undefined;
          if (existingIndex !== undefined) {
            // Defensive out-of-order path: a result row was projected first.
            // Merge the late start into it without guessing by tool name.
            const existing = entries[existingIndex];
            if (existing?.kind === "tool") {
              const args = logData["args"];
              entries[existingIndex] = {
                ...existing,
                tool: name === "unknown" ? existing.tool : name,
                ...(owns(logData, "args") ? { args, detail: formatToolArgs(args) } : {}),
                orphaned: false,
              };
            }
            continue;
          }

          const args = logData["args"];
          const entry: ToolExecutionEntry = {
            id: callId ? `tool:${callId}` : rawEntryId(log, rawIndex, ":tool-start"),
            kind: "tool",
            tool: name,
            ...(callId ? { toolCallId: callId } : {}),
            status: options.isRunTerminal ? (callId ? "interrupted" : "unknown") : "running",
            ...(owns(logData, "args") ? { args, detail: formatToolArgs(args) } : {}),
            ...(typeof durationMs === "number" && Number.isFinite(durationMs)
              ? { durationMs }
              : {}),
            level: log.level || "debug",
            createdAt: log.createdAt,
          };
          if (callId) toolEntryByCallId.set(callId, entries.length);
          entries.push(entry);
          continue;
        }

        const status: ToolExecutionStatus = logData["isError"] === true ? "failed" : "success";
        const existingIndex = callId ? toolEntryByCallId.get(callId) : undefined;
        if (existingIndex !== undefined) {
          const existing = entries[existingIndex];
          if (existing?.kind === "tool") {
            entries[existingIndex] = {
              ...existing,
              tool: existing.tool === "unknown" ? name : existing.tool,
              status,
              result: logData["result"],
              ...(typeof durationMs === "number" && Number.isFinite(durationMs)
                ? { durationMs }
                : {}),
              completedAt: log.createdAt,
            };
          }
          continue;
        }

        const resultEntry: ToolExecutionEntry = {
          id: callId ? `tool:${callId}` : rawEntryId(log, rawIndex, ":tool-result"),
          kind: "tool",
          tool: name,
          ...(callId ? { toolCallId: callId } : {}),
          status,
          result: logData["result"],
          orphaned: true,
          ...(typeof durationMs === "number" && Number.isFinite(durationMs) ? { durationMs } : {}),
          level: log.level || "debug",
          createdAt: log.createdAt,
          completedAt: log.createdAt,
        };
        if (callId) toolEntryByCallId.set(callId, entries.length);
        entries.push(resultEntry);
        continue;
      }

      entries.push({
        id: rawEntryId(log, rawIndex, ":runtime"),
        kind: "runtime",
        message,
        sourceType: log.type || "progress",
        level: log.level || "debug",
        createdAt: log.createdAt,
      });
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

/** Text color by severity level (overrides type color when set). */
export const levelColors: Record<string, string> = {
  warn: "text-amber-400",
  error: "text-destructive",
};
