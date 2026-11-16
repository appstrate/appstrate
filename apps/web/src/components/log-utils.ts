// SPDX-License-Identifier: Apache-2.0

// Execution-trace types and pure projection functions shared between the run
// page and its viewer. Persisted `run_logs` stay append-only; this module owns
// the richer, correlated shape the UI renders.

import { jsonText } from "@appstrate/afps-shared/json-text";
import { isApiCallToolName, type ToolIntegration } from "@appstrate/core/integration";
import { asRecordOrNull } from "@appstrate/core/safe-json";
import { LOG_TOOL, platformTool } from "../lib/platform-tool-results";

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
  /** The name the model called. */
  tool: string;
  toolCallId?: string;
  /** Absent for a tool no integration serves (the runner's own, Pi's built-ins). */
  integration?: ToolIntegration;
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
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Omitted when the runner could not observe the turn's start. */
  latencyMs?: number;
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

/** Per-turn breakdown for `TurnsTable`. Total: non-turn or malformed rows are skipped. */
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
    // Deliberately NOT `readNumber` (as for `latencyMs`): a missing window is "unknown",
    // so the key stays ABSENT rather than defaulted.
    const contextWindow = d["contextWindow"];

    rows.push({
      index: d["index"],
      // Always emitted, so absent means malformed: fall to 0, do NOT recompute a total
      // from the parts (that plots a bar never measured).
      contextTokens: readNumber(d["contextTokens"], 0),
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

/**
 * An `api_call` reads as the request it sent; any other tool, or a call missing the method or
 * target its schema requires (so never sent), as its flattened arguments.
 */
function toolDetail(args: unknown, integration: ToolIntegration | undefined): string {
  const request = integration && isApiCallToolName(integration.tool) ? asRecordOrNull(args) : null;
  if (request && typeof request.method === "string" && typeof request.target === "string") {
    return `${request.method} ${request.target}`;
  }
  return formatToolArgs(args);
}

function readIntegration(data: Record<string, unknown>): ToolIntegration | undefined {
  const raw = asRecordOrNull(data["integration"]);
  const id = stringValue(raw?.id);
  const tool = stringValue(raw?.tool);
  if (!id || !tool) return undefined;
  const title = stringValue(raw?.title);
  return { id, tool, ...(title ? { title } : {}) };
}

/**
 * A call of the platform `log` tool writes the journal row (`event === "log"`) that says the
 * same thing: its tool row is shown only when the call did not complete, which writes none.
 */
function isRedundantLogCall(entry: ToolExecutionEntry): boolean {
  return (
    platformTool(entry.integration) === LOG_TOOL &&
    (entry.status === "running" || entry.status === "success")
  );
}

const ASSISTANT_MESSAGE_EVENT = "assistant_message";

function owns(value: object, key: string): boolean {
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
      // Turn breadcrumbs would drown the log lines; rendered by `buildTurnRows` → `TurnsTable`.
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
              const integration = existing.integration ?? readIntegration(logData);
              entries[existingIndex] = {
                ...existing,
                tool: name === "unknown" ? existing.tool : name,
                ...(integration ? { integration } : {}),
                ...(owns(logData, "args") ? { args: logData["args"] } : {}),
                orphaned: false,
              };
            }
            continue;
          }

          const integration = readIntegration(logData);
          const entry: ToolExecutionEntry = {
            id: callId ? `tool:${callId}` : rawEntryId(log, rawIndex, ":tool-start"),
            kind: "tool",
            tool: name,
            ...(callId ? { toolCallId: callId } : {}),
            ...(integration ? { integration } : {}),
            status: options.isRunTerminal ? (callId ? "interrupted" : "unknown") : "running",
            ...(owns(logData, "args") ? { args: logData["args"] } : {}),
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
            const integration = existing.integration ?? readIntegration(logData);
            entries[existingIndex] = {
              ...existing,
              tool: existing.tool === "unknown" ? name : existing.tool,
              ...(integration ? { integration } : {}),
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

        const integration = readIntegration(logData);
        const resultEntry: ToolExecutionEntry = {
          id: callId ? `tool:${callId}` : rawEntryId(log, rawIndex, ":tool-result"),
          kind: "tool",
          tool: name,
          ...(callId ? { toolCallId: callId } : {}),
          ...(integration ? { integration } : {}),
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

  // Settled last: a call's identity, arguments and status may each arrive on either event.
  const settled = entries.flatMap((entry): ExecutionEntry[] => {
    if (entry.kind !== "tool") return [entry];
    if (isRedundantLogCall(entry)) return [];
    return [
      owns(entry, "args") ? { ...entry, detail: toolDetail(entry.args, entry.integration) } : entry,
    ];
  });
  return { entries: settled, output };
}

/** The integrations the journal's tool calls reached, in order of first call. */
export function journalIntegrationIds(entries: readonly ExecutionEntry[]): string[] {
  const ids = new Set<string>();
  for (const entry of entries)
    if (entry.kind === "tool" && entry.integration) ids.add(entry.integration.id);
  return [...ids];
}

export interface IntegrationLook {
  name: string;
  icon?: string | null;
  /** Its row is still being read: the name and icon are not known yet. */
  pending: boolean;
}

/** An integration's display name and icon; its id stands in for a name the read does not know. */
export type JournalIntegrations = (integrationId: string) => IntegrationLook;

const JOURNAL_TYPES = {
  agent: "message",
  tool: "tool",
  log: "journal",
  runtime: "system",
} as const satisfies Record<ExecutionEntry["kind"], string>;
export type JournalTypeFilter = (typeof JOURNAL_TYPES)[ExecutionEntry["kind"]];
export const JOURNAL_TYPE_VALUES = Object.values(JOURNAL_TYPES);

/** A tool row keeps one type while it runs and once it settles: its status icon tells which. */
export function journalType(entry: ExecutionEntry): JournalTypeFilter {
  return JOURNAL_TYPES[entry.kind];
}

/** What the journal shows: an empty list of values does not filter on its dimension. */
export interface JournalFilters {
  levels: readonly string[];
  types: readonly string[];
  integrations: readonly string[];
  showTools: boolean;
  /** Trimmed and lower-cased in `locale`; empty matches every entry. */
  query: string;
  locale: string;
}

/** The entries the journal's filters and search keep, in order. */
export function filterJournal(
  entries: readonly ExecutionEntry[],
  filters: JournalFilters,
  t: (key: string) => string,
  integrations: JournalIntegrations,
): ExecutionEntry[] {
  const { levels, types, showTools, query, locale } = filters;
  return entries.filter((entry) => {
    if (!showTools && entry.kind === "tool") return false;
    if (levels.length > 0 && !levels.includes(journalLevel(entry))) return false;
    if (types.length > 0 && !types.includes(journalType(entry))) return false;
    if (
      filters.integrations.length > 0 &&
      !(
        entry.kind === "tool" &&
        entry.integration &&
        filters.integrations.includes(entry.integration.id)
      )
    ) {
      return false;
    }
    return (
      !query ||
      journalSearchText(entry, t, (id) => integrations(id).name)
        .toLocaleLowerCase(locale)
        .includes(query)
    );
  });
}

/** Consecutive lines of the runner, drawn as one row that opens in place. */
export interface JournalGroup {
  kind: "group";
  /** Its first entry's id, which later lines of the run do not change. */
  id: string;
  entries: ExecutionEntry[];
}

/** What the journal draws on one line: an entry, or a group of them. */
export type JournalRow = ExecutionEntry | JournalGroup;

function foldable(entry: ExecutionEntry): boolean {
  return entry.kind === "runtime" && journalLevel(entry) === "info";
}

/**
 * The rows the journal draws from its filtered entries: each run of two or more consecutive
 * `runtime` entries of level info or debug is one group (a warning or an error stays a row of
 * its own and ends the run). A search or a level or type filter in force folds nothing: the
 * reader is looking for lines.
 */
export function journalRows(
  entries: readonly ExecutionEntry[],
  filters: Pick<JournalFilters, "levels" | "types" | "query">,
): JournalRow[] {
  if (filters.query || filters.levels.length > 0 || filters.types.length > 0) return [...entries];
  const rows: JournalRow[] = [];
  let index = 0;
  while (index < entries.length) {
    let end = index;
    while (end < entries.length && foldable(entries[end]!)) end += 1;
    if (end - index >= 2) {
      rows.push({
        kind: "group",
        id: `group:${entries[index]!.id}`,
        entries: entries.slice(index, end),
      });
      index = end;
    } else {
      rows.push(entries[index]!);
      index += 1;
    }
  }
  return rows;
}

/**
 * The groups drawn open. A group is as the reader set it (`open`); left alone, it is open while
 * it is a live run's last row (its lines are still arriving) and folds once another event
 * follows it or the run ends. One holding the open row (a reload, a shared link) stays open.
 */
export function expandedJournalGroups(
  rows: readonly JournalRow[],
  state: {
    open: Readonly<Record<string, boolean>>;
    live: boolean;
    selectedEntryId?: string | null;
  },
): Set<string> {
  const tail = rows[rows.length - 1];
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.kind !== "group") continue;
    const open =
      state.open[row.id] ??
      ((state.live && row === tail) ||
        row.entries.some((entry) => entry.id === state.selectedEntryId));
    if (open) ids.add(row.id);
  }
  return ids;
}

function timeOf(value: Date | string | null | undefined): number {
  return value ? new Date(value).getTime() : Number.NaN;
}

/** The time between a group's first and last lines, 0 when either was not dated. */
export function journalGroupElapsedMs(group: JournalGroup): number {
  const { entries } = group;
  const elapsed = timeOf(entries[entries.length - 1]?.createdAt) - timeOf(entries[0]?.createdAt);
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
}

/** The tools the runner itself offers the model (`@appstrate/runner-pi` harness tools). */
const HARNESS_TOOL_LABELS = new Map([
  ["output", "log.harness.output"],
  ["publish_file", "log.harness.publish_file"],
]);

/** What a tool row is called: its server's title or name, a harness tool's label, else the name the model called. */
export function toolLabel(entry: ToolExecutionEntry, t: (key: string) => string): string {
  if (entry.integration) return entry.integration.title ?? entry.integration.tool;
  const harnessKey = HARNESS_TOOL_LABELS.get(entry.tool);
  return harnessKey ? t(harnessKey) : entry.tool;
}

/** What the journal's search reads of an entry: a tool call by every name it goes by. */
export function journalSearchText(
  entry: ExecutionEntry,
  t: (key: string) => string,
  integrationName: (integrationId: string) => string,
): string {
  if (entry.kind === "tool") {
    const integration = entry.integration;
    return [
      entry.tool,
      toolLabel(entry, t),
      integration?.tool,
      integration?.id,
      integration && integrationName(integration.id),
      entry.detail,
      entry.status,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return [entry.message, entry.kind === "runtime" ? entry.sourceType : undefined]
    .filter(Boolean)
    .join(" ");
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
