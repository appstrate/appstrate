// SPDX-License-Identifier: Apache-2.0

/**
 * Pure (React-free, unit-testable) helpers for the in-chat run panel.
 *
 * When the assistant launches a run — via `invoke_operation(runAgent|runInline)`
 * or the bundled `run_and_wait` tool — the result carries the created run's
 * `id`. The panel reads that id, fetches the persisted log history once
 * (`GET /api/runs/:id/logs`), then tails new lines live over the run's SSE
 * stream (`GET /api/realtime/runs/:id?verbose=true`). These helpers parse and
 * merge both sources so the React layer (`use-run-log-stream.ts`,
 * `run-panel.tsx`) stays a thin shell.
 *
 * The schemas here are deliberately a MINIMAL local subset of the canonical
 * `@appstrate/shared-types` realtime schemas: depending on shared-types would
 * pull `@appstrate/db` (it imports `runStatusEnum`/`tokenUsage`) into the chat
 * module, coupling the UI to the database package. We only need a handful of
 * fields, so we redeclare them and stay decoupled. Field names match the wire
 * shape (post-camelize) exactly so a server payload validates unchanged.
 */

import { z } from "zod";
import { asRecord, unwrapResult } from "./tool-result.ts";

/** Operation ids whose result launches a run we can follow. */
export const RUN_LAUNCH_OPS = ["runAgent", "runInline", "run_and_wait"] as const;
export type RunLaunchOp = (typeof RUN_LAUNCH_OPS)[number];

/** All run statuses (mirrors `packages/db/src/schema/enums.ts`). */
export const RUN_STATUSES = [
  "pending",
  "running",
  "success",
  "failed",
  "timeout",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Statuses past which a run never changes again (mirrors TERMINAL_RUN_STATUSES). */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "success",
  "failed",
  "timeout",
  "cancelled",
]);

export function isTerminalStatus(status: string | null | undefined): status is RunStatus {
  return typeof status === "string" && TERMINAL_RUN_STATUSES.has(status as RunStatus);
}

/** Is this op-id one whose result we can mine for a launched run id? */
export function isRunLaunchOp(opId: string | undefined): opId is RunLaunchOp {
  return !!opId && (RUN_LAUNCH_OPS as readonly string[]).includes(opId);
}

/**
 * Minimal log-line shape shared by the SSE `run_log` frame and the
 * `GET /runs/:id/logs` list rows — both carry the same `run_logs` columns
 * (the SSE event adds org/app ids we ignore). `level` is open-coded rather
 * than enum'd so a future level can't drop a line; `data` may be a record,
 * the literal `"[payload too large]"`, or absent (non-verbose subscribers).
 */
export const runLogLineSchema = z.object({
  id: z.number(),
  level: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  event: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
  data: z
    .union([z.record(z.string(), z.unknown()), z.string()])
    .nullable()
    .optional(),
  createdAt: z.string().nullable().optional(),
});
export type RunLogLine = z.infer<typeof runLogLineSchema>;

/** Minimal `run_update` SSE frame — only the lifecycle fields the panel reads. */
export const runUpdateLiteSchema = z.object({
  id: z.string().optional(),
  status: z.string(),
  error: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
});
export type RunUpdateLite = z.infer<typeof runUpdateLiteSchema>;

/**
 * Minimal `GET /api/runs/:id` shape — the run's status + timing. Fetched once at
 * mount so a reopened/refreshed conversation seeds the badge and execution time
 * for a run that already finished (no live `run_update` ever arrives for it).
 *
 * Reads snake_case `started_at` / `completed_at`: that is the canonical run REST
 * DTO shape the rest of the app already consumes (`run.started_at` everywhere).
 * It differs from the camelCase `run_update` SSE frame (`parseRunUpdateFrame`) —
 * a deliberate, pre-existing split (REST DTO = snake, realtime = camel), not a
 * mix introduced here: each parser matches its own endpoint. We normalise to the
 * camelCase shape used internally so the hook state stays one convention.
 */
export const runTimingSchema = z
  .object({
    status: z.string().optional(),
    started_at: z.string().nullable().optional(),
    completed_at: z.string().nullable().optional(),
  })
  .transform((d) => ({
    status: d.status,
    startedAt: d.started_at ?? null,
    completedAt: d.completed_at ?? null,
  }));
export type RunTiming = z.infer<typeof runTimingSchema>;

/** Parse a `GET /api/runs/:id` body into its status + timing, or undefined. */
export function parseRunTiming(body: unknown): RunTiming | undefined {
  const parsed = runTimingSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/**
 * `run_update` frame from the org-wide realtime stream, with the fields needed
 * to discover the run a blocking `run_and_wait` just launched (its id only
 * appears in the tool result once the call returns, which is after the run is
 * already done — too late to stream live).
 */
export const runUpdateDiscoverySchema = z.object({
  operation: z.string().optional(),
  id: z.string(),
  packageId: z.string().nullable().optional(),
  status: z.string().optional(),
});
export type RunUpdateDiscovery = z.infer<typeof runUpdateDiscoverySchema>;

export function parseRunUpdateDiscovery(raw: string): RunUpdateDiscovery | undefined {
  const parsed = runUpdateDiscoverySchema.safeParse(safeJsonParse(raw));
  return parsed.success ? parsed.data : undefined;
}

/**
 * Does this org-wide `run_update` correspond to the run a `run_and_wait` just
 * launched? `target` is the agent's package id (`@scope/name`) for `kind:agent`
 * — an exact match, robust. For an inline run the package id is a server-minted
 * shadow we can't predict, so `target` is undefined and we accept any freshly
 * INSERTed run (the chat launches one at a time, so the new row is ours).
 */
export function matchesLaunchedRun(
  update: RunUpdateDiscovery,
  target: string | undefined,
): boolean {
  if (!update.id.startsWith("run_")) return false;
  if (target) return update.packageId === target;
  return update.operation === "INSERT";
}

/**
 * Pull the launched run id out of a tool-call result. The invoke-operation
 * envelope is `{ status, body }` (the run resource lives in `body`); the
 * bundled `run_and_wait` tool returns the run resource at the top level. Try
 * `body.id` first, then a top-level `id`. Guarded to `run_`-prefixed strings
 * so an unrelated id (e.g. a connection id) can never spin up a run panel.
 */
export function extractRunId(result: unknown): string | undefined {
  const unwrapped = asRecord(unwrapResult(result));
  if (!unwrapped) return undefined;
  const fromBody = asRecord(unwrapped.body)?.id;
  if (typeof fromBody === "string" && fromBody.startsWith("run_")) return fromBody;
  const top = unwrapped.id;
  if (typeof top === "string" && top.startsWith("run_")) return top;
  return undefined;
}

/**
 * Pull the run status out of a launch result, when present (`body.status` for
 * the invoke envelope, top-level `status` for `run_and_wait`). Returns the raw
 * string — callers decide whether it is a known/terminal status.
 */
export function extractRunStatus(result: unknown): string | undefined {
  const unwrapped = asRecord(unwrapResult(result));
  if (!unwrapped) return undefined;
  const fromBody = asRecord(unwrapped.body)?.status;
  if (typeof fromBody === "string") return fromBody;
  // Top-level `status` is the run's own status only when no HTTP envelope wraps
  // it — guard against the envelope's numeric HTTP `status`.
  const top = unwrapped.status;
  if (typeof top === "string") return top;
  return undefined;
}

/** Best-effort `JSON.parse`, `undefined` on malformed input. */
export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Parse one SSE `run_log` frame's `data` string into a log line, or undefined. */
export function parseRunLogFrame(raw: string): RunLogLine | undefined {
  const parsed = runLogLineSchema.safeParse(safeJsonParse(raw));
  return parsed.success ? parsed.data : undefined;
}

/** Parse one SSE `run_update` frame's `data` string, or undefined. */
export function parseRunUpdateFrame(raw: string): RunUpdateLite | undefined {
  const parsed = runUpdateLiteSchema.safeParse(safeJsonParse(raw));
  return parsed.success ? parsed.data : undefined;
}

/**
 * Parse the `GET /runs/:id/logs` list envelope (`{ object:"list", data, … }`)
 * into log lines, dropping any malformed row rather than failing the batch.
 */
export function parseLogListResponse(body: unknown): RunLogLine[] {
  const data = asRecord(body)?.data;
  if (!Array.isArray(data)) return [];
  const out: RunLogLine[] = [];
  for (const row of data) {
    const parsed = runLogLineSchema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * Merge incoming log lines into the existing list: dedup by `id` (the SSE tail
 * and the history fetch overlap), keep ascending `id` order. Stable + pure so
 * the hook can call it on every frame without ordering surprises.
 */
export function mergeLogs(
  existing: readonly RunLogLine[],
  incoming: readonly RunLogLine[],
): RunLogLine[] {
  if (incoming.length === 0) return existing as RunLogLine[];
  const byId = new Map<number, RunLogLine>();
  for (const line of existing) byId.set(line.id, line);
  for (const line of incoming) byId.set(line.id, line);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** Highest log id seen, for the `?since=` cursor on a history refetch. 0 if empty. */
export function maxLogId(logs: readonly RunLogLine[]): number {
  let max = 0;
  for (const line of logs) if (line.id > max) max = line.id;
  return max;
}

/**
 * Build the per-run SSE URL. Returns `undefined` when org/app context is
 * missing (the caller then renders the static card instead of a live panel).
 * `verbose=true` is REQUIRED: the server strips `run_log.data` for non-verbose
 * subscribers, so without it the panel would show empty lines.
 */
export function buildRunSseUrl(args: {
  runId: string;
  orgId: string | undefined;
  applicationId: string | undefined;
}): string | undefined {
  const { runId, orgId, applicationId } = args;
  if (!orgId || !applicationId) return undefined;
  const qs = new URLSearchParams({
    orgId,
    applicationId,
    verbose: "true",
  });
  return `/api/realtime/runs/${encodeURIComponent(runId)}?${qs.toString()}`;
}

/**
 * Build the ORG-WIDE realtime run-stream URL (`GET /api/realtime/runs`) used to
 * discover the run a blocking `run_and_wait` just launched. NOTE: the path is
 * `/api/realtime/runs`, NOT `/api/realtime` — the latter is not a route (the
 * realtime router only exposes `/runs`, `/runs/:id`, `/agents/:id/runs`), and
 * only paths under `/api/realtime/` skip the auth middleware. Returns undefined
 * without org/app context.
 */
export function buildOrgRunsSseUrl(args: {
  orgId: string | undefined;
  applicationId: string | undefined;
}): string | undefined {
  const { orgId, applicationId } = args;
  if (!orgId || !applicationId) return undefined;
  const qs = new URLSearchParams({ orgId, applicationId });
  return `/api/realtime/runs?${qs.toString()}`;
}

/** Read org/app ids out of the chat host's forwarded headers (case-tolerant). */
export function orgAppFromHeaders(headers: Record<string, string> | undefined): {
  orgId: string | undefined;
  applicationId: string | undefined;
} {
  const h = headers ?? {};
  return {
    orgId: h["X-Org-Id"] ?? h["x-org-id"],
    applicationId: h["X-Application-Id"] ?? h["x-application-id"],
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Derive a human label for the launched run from the launch tool-call args.
 * Handles both shapes: `invoke_operation` (`operation_id` + `path_params`) and
 * the `run_and_wait` tool (`kind` + `scope`/`name`/`manifest`). Returns the
 * agent id (`@scope/name`) for an agent run, the manifest's display name/name
 * for an inline run, or a generic "Run inline" / undefined fallback.
 */
export function extractAgentLabel(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const pathParams = asRecord(args.path_params);
  const scope = nonEmptyString(pathParams?.scope) ?? nonEmptyString(args.scope);
  const name = nonEmptyString(pathParams?.name) ?? nonEmptyString(args.name);
  if (scope && name) return `${scope}/${name}`;

  const manifest = asRecord(args.manifest);
  const manifestName = nonEmptyString(manifest?.display_name) ?? nonEmptyString(manifest?.name);
  if (manifestName) return manifestName;

  const isInline =
    nonEmptyString(args.kind) === "inline" || nonEmptyString(args.operation_id) === "runInline";
  return isInline ? "Run inline" : undefined;
}

/** Display text for one log line — `message`, then `event`, then compact `data`. */
export function logLineText(line: RunLogLine): string {
  if (nonEmptyString(line.message)) return line.message as string;
  if (nonEmptyString(line.event)) return line.event as string;
  if (typeof line.data === "string") return line.data;
  if (line.data && typeof line.data === "object") return JSON.stringify(line.data);
  return "";
}

/** Text of the most recent log line with displayable content, or undefined. */
export function lastLogText(logs: readonly RunLogLine[]): string | undefined {
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const text = logLineText(logs[i]!);
    if (text) return text;
  }
  return undefined;
}

/**
 * Like `lastLogText`, but skips `debug`-level lines — debug logs are noise we
 * never surface in the chat card.
 */
export function lastVisibleLogText(logs: readonly RunLogLine[]): string | undefined {
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    if (logs[i]!.level === "debug") continue;
    const text = logLineText(logs[i]!);
    if (text) return text;
  }
  return undefined;
}

/** One displayable log line: its stable `id` (animation key) and rendered text. */
export interface VisibleLogEntry {
  id: number;
  text: string;
}

/**
 * The ordered sequence of the agent's own log-tool output — the queue the run
 * card tickers through one entry at a time. ONLY `event === "log"` rows qualify:
 * those come from the agent's explicit `log` runtime tool (sink tags them so),
 * never the auto-emitted runtime lifecycle / tool-call breadcrumbs (which share
 * `type='progress'` but keep `event='progress'`), nor `output`/`report`/system
 * rows. Keeps ascending `id` order (same as `mergeLogs`), so the last element is
 * the most recent line; `id` doubles as the React key the line animates on.
 */
export function visibleLogEntries(logs: readonly RunLogLine[]): VisibleLogEntry[] {
  const out: VisibleLogEntry[] = [];
  for (const line of logs) {
    if (line.event !== "log") continue;
    // Text from `message` (then `data`) only — NOT `logLineText`, whose `event`
    // fallback would surface the literal "log" tag for a message-less row.
    const text =
      nonEmptyString(line.message) ??
      (typeof line.data === "string"
        ? line.data
        : line.data && typeof line.data === "object"
          ? JSON.stringify(line.data)
          : undefined);
    if (text) out.push({ id: line.id, text });
  }
  return out;
}

/** Run package id from a launch result (`body.packageId`, then top-level). */
export function extractRunPackageId(result: unknown): string | undefined {
  const unwrapped = asRecord(unwrapResult(result));
  if (!unwrapped) return undefined;
  return nonEmptyString(asRecord(unwrapped.body)?.packageId) ?? nonEmptyString(unwrapped.packageId);
}

/**
 * Build the in-app run-detail URL (`/agents/{packageId}/runs/{runId}`, the same
 * route `run-row.tsx` links to). `undefined` when the run has no package id
 * (orphaned) so the caller can omit the link. `packageId` keeps its `@scope/name`
 * slashes literal to match the route; only the run id is encoded.
 */
export function buildRunPageHref(packageId: string | undefined, runId: string): string | undefined {
  if (!packageId) return undefined;
  return `/agents/${packageId}/runs/${encodeURIComponent(runId)}`;
}
