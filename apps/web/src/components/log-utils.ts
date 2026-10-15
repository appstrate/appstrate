// SPDX-License-Identifier: Apache-2.0

// Execution-trace types and pure projection functions shared between the run
// page and its viewer. Persisted `run_logs` stay append-only; this module owns
// the richer, correlated shape the UI renders.

import { jsonText } from "@appstrate/afps-shared/json-text";

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
   * Wall time of a tool call in ms (`data.durationMs`); omitted when the runner could
   * not pair start and end, never a misleading zero. Live frames carry it only on
   * `verbose=true` streams: `stripPayload` (`apps/api/src/routes/realtime.ts`) drops
   * `run_log.data` for the non-verbose org-wide stream.
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

/** An entry's level in the journal: a tool call that did not complete is an error. */
export function journalLevel(entry: ExecutionEntry): "info" | "warn" | "error" {
  if (entry.kind === "tool" && (entry.status === "failed" || entry.status === "interrupted"))
    return "error";
  if (entry.level === "error") return "error";
  if (entry.level === "warn") return "warn";
  return "info";
}

/**
 * One settled assistant turn, projected from a `data.event === "turn"` run-log row.
 * `contextTokens` is the prompt the provider saw (input + cache read + cache write,
 * output excluded).
 */
export interface RunTurnRow {
  index: number;
  contextTokens: number;
  /**
   * The window `contextTokens` is a share of, as stated by the runner for THIS turn
   * (it alone knows the container-side default). Absent when unknown, never zero.
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

/** Per-turn context readings, for the run's context gauge. Total: non-turn or malformed rows are skipped. */
export function buildTurnRows(rawLogs: RawLog[]): RunTurnRow[] {
  const rows: RunTurnRow[] = [];
  for (const log of rawLogs) {
    if (!isTurnRow(log)) continue;
    const d = log.data!;
    // `index` is the row's identity — without it there is nothing to plot.
    if (typeof d["index"] !== "number" || !Number.isFinite(d["index"])) continue;

    // Deliberately NOT `readNumber`: a missing window is "unknown",
    // so the key stays ABSENT rather than defaulted.
    const contextWindow = d["contextWindow"];

    rows.push({
      index: d["index"],
      // Always emitted, so absent means malformed: fall to 0, do NOT recompute a total
      // from the parts (that plots a bar never measured).
      contextTokens: readNumber(d["contextTokens"], 0),
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
    return args === undefined ? "" : jsonText(args).slice(0, 200);
  }

  const parts: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    const str = jsonText(value);
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
 * Starts and results share the `appstrate.progress` envelope; the payload discriminates:
 * results always carry `isError`, starts carry `args` or a `Tool:` message.
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

/** `assistant_message` is the only marker of model prose; untagged progress rows are runner lifecycle (`runtime` kind). */
function isAgentText(log: RawLog): boolean {
  return log.type === "progress" && log.data?.["event"] === ASSISTANT_MESSAGE_EVENT;
}

interface BuildLogEntriesOptions {
  /** Marks correlated starts with no result as interrupted instead of spinning forever. */
  isRunTerminal?: boolean;
}

/**
 * Project raw run logs into an execution trace and structured output. Tool starts and
 * results collapse by exact `toolCallId` only (never by name: parallel calls of the
 * same tool settle out of order); id-less legacy rows stay separate, `unknown` once terminal.
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
    } else if (log.event === "run_completed") {
      continue;
    } else if (isTurnRow(log)) {
      // Turn breadcrumbs would drown the log lines; read apart by `buildTurnRows`.
    } else {
      const logData = log.data ?? {};
      const message = (logData.message as string) || log.message || "";
      if (!message) continue;

      // Explicit channels win over message-shape fallbacks: a log message may begin with "Tool:".
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
            // Out-of-order: a result row was projected first; merge the late start into it.
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
