// SPDX-License-Identifier: Apache-2.0

/**
 * Pure (React-free, unit-testable) helpers for the in-chat run progress component.
 *
 * When the assistant launches a run — via `invoke_operation(runAgent|runInline)`
 * or the bundled `run_and_wait` tool — the result carries the created run's
 * `id`. The panel reads that id, fetches the persisted log history once
 * (`GET /api/runs/:id/logs`), then tails new lines live over the run's SSE
 * stream (`GET /api/realtime/runs/:id?verbose=true`). These helpers parse and
 * merge both sources so the React layer (`use-run-log-stream.ts`,
 * `chat-run-progress-card.tsx`) stays a thin shell.
 *
 * The schemas here are deliberately a MINIMAL local subset of the canonical
 * `@appstrate/shared-types` realtime schemas: depending on shared-types would
 * pull `@appstrate/db` (it imports `runStatusEnum`/`tokenUsage`) into the chat
 * module, coupling the UI to the database package. We only need a handful of
 * fields, so we redeclare them and stay decoupled. Field names match the wire
 * shape (post-camelize) exactly so a server payload validates unchanged.
 */

import { z } from "zod";
import type { RunStatus as DbRunStatus, TerminalRunStatus } from "@appstrate/db/schema";
import { parseDocumentUri } from "@appstrate/core/document-uri";
import { asRecord, unwrapResult } from "./tool-result.ts";

/** Operation ids whose result launches a run we can follow. */
export const RUN_LAUNCH_OPS = ["runAgent", "runInline", "run_and_wait"] as const;
export type RunLaunchOp = (typeof RUN_LAUNCH_OPS)[number];

/**
 * All run statuses. Kept as a local literal so this browser-bundled UI
 * module never pulls `@appstrate/db` values (drizzle) into the web build —
 * the type-only parity assertions below fail compilation if either side
 * drifts from the canonical enums in `packages/db/src/schema/enums.ts`.
 */
export const RUN_STATUSES = [
  "pending",
  "running",
  "success",
  "failed",
  "timeout",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Statuses past which a run never changes again. */
const terminalRunStatuses = ["success", "failed", "timeout", "cancelled"] as const;
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(
  terminalRunStatuses,
);

// Compile-time parity checks — fail to compile if either literal drifts
// from the canonical @appstrate/db enums (type-only import, erased at build).
type _RunStatusParity = [DbRunStatus] extends [RunStatus]
  ? [RunStatus] extends [DbRunStatus]
    ? true
    : never
  : never;
type _TerminalParity = [TerminalRunStatus] extends [(typeof terminalRunStatuses)[number]]
  ? [(typeof terminalRunStatuses)[number]] extends [TerminalRunStatus]
    ? true
    : never
  : never;
const _runStatusParity: _RunStatusParity = true;
const _terminalParity: _TerminalParity = true;
void _runStatusParity;
void _terminalParity;

export function isTerminalStatus(status: string | null | undefined): status is RunStatus {
  return typeof status === "string" && TERMINAL_RUN_STATUSES.has(status as RunStatus);
}

export function terminalRunLineText(status: RunStatus | undefined): string {
  switch (status) {
    case "success":
      return "Complété";
    case "failed":
      return "Échec";
    case "timeout":
      return "Expiré";
    case "cancelled":
      return "Annulé";
    default:
      return "Terminé";
  }
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
  packageId: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  duration: z.number().nullable().optional(),
});
export type RunUpdateLite = z.infer<typeof runUpdateLiteSchema>;

/**
 * Pull the launched run id out of a tool-call result. The invoke-operation
 * envelope is `{ status, body }` (the run resource lives in `body`); the
 * bundled `run_and_wait` tool returns the run resource at the top level. Try
 * `body.id` first, then a top-level `id`. Guarded to `run_`-prefixed strings
 * so an unrelated id (e.g. a connection id) can never spin up run progress UI.
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
 * Parse a `GET /api/runs/:id` run resource down to the same lifecycle subset as
 * a `run_update` frame (the resource is a superset — extra fields are dropped).
 * Used to seed the run badge immediately on a mid-run reload, instead of waiting
 * for the SSE snapshot: the persisted `run_and_wait` result only carries the
 * transient launch status (`pending`), so without this the card would read
 * "Lancement" for an already-running run until the first live frame arrives.
 */
export function parseRunResource(body: unknown): RunUpdateLite | undefined {
  const parsed = runUpdateLiteSchema.safeParse(body);
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

/**
 * Build the per-run SSE URL. Returns `undefined` when org/app context is
 * missing (the caller then renders the static card instead of live run progress).
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
    // Text from `message` (then `data`) only — never the `event` field, whose
    // value here is the literal "log" tag, not displayable content.
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

/**
 * A document surfaced in a run card: the stable id + uri (for chaining) plus a
 * display name. `mime`/`size` are optional (present in the persisted tool
 * result, absent on some log frames).
 */
export interface ChatRunDocument {
  id: string;
  uri: string;
  name: string;
  mime?: string;
  size?: number;
}

function asChatRunDocument(raw: unknown): ChatRunDocument | undefined {
  const r = asRecord(raw);
  if (!r) return undefined;
  // `id` in the tool result; `document_id` in the `document.published` log frame.
  const id = nonEmptyString(r.id) ?? nonEmptyString(r.document_id);
  const uri = nonEmptyString(r.uri) ?? (id ? `document://${id}` : undefined);
  const name = nonEmptyString(r.name);
  if (!id || !uri || !name) return undefined;
  const doc: ChatRunDocument = { id, uri, name };
  const mime = nonEmptyString(r.mime);
  if (mime) doc.mime = mime;
  if (typeof r.size === "number") doc.size = r.size;
  return doc;
}

/**
 * Pull the published `documents` list out of a persisted run_and_wait tool
 * result (`documents` at the top level, or nested under the invoke envelope's
 * `body`). Empty when the run produced none — survives reload because it reads
 * the persisted message part, not live state.
 */
export function extractRunDocuments(result: unknown): ChatRunDocument[] {
  const unwrapped = asRecord(unwrapResult(result));
  if (!unwrapped) return [];
  const raw = Array.isArray(unwrapped.documents)
    ? unwrapped.documents
    : Array.isArray(asRecord(unwrapped.body)?.documents)
      ? (asRecord(unwrapped.body)!.documents as unknown[])
      : [];
  const out: ChatRunDocument[] = [];
  for (const item of raw) {
    const doc = asChatRunDocument(item);
    if (doc) out.push(doc);
  }
  return out;
}

/**
 * Extract published documents from the live run log stream — the
 * `type='result' event='document'` frames the sink persists for each
 * `document.published` event. Lets the card show a chip the moment an agent
 * publishes, before the run terminates.
 */
export function publishedDocumentsFromLogs(logs: readonly RunLogLine[]): ChatRunDocument[] {
  const out: ChatRunDocument[] = [];
  for (const line of logs) {
    if (line.event !== "document") continue;
    if (!line.data || typeof line.data !== "object") continue;
    const doc = asChatRunDocument(line.data);
    if (doc) out.push(doc);
  }
  return out;
}

/** Merge two document lists, deduping by id (first occurrence wins). */
export function mergeRunDocuments(
  a: readonly ChatRunDocument[],
  b: readonly ChatRunDocument[],
): ChatRunDocument[] {
  const byId = new Map<string, ChatRunDocument>();
  for (const doc of [...a, ...b]) if (!byId.has(doc.id)) byId.set(doc.id, doc);
  return [...byId.values()];
}

/** Content-download URL for a document (the `/content` route handles the 307). */
export function documentContentHref(id: string): string {
  return `/api/documents/${encodeURIComponent(id)}/content`;
}

/**
 * An attachment's resolved content: a downloadable stored document, or an inert
 * placeholder.
 *
 * The `@assistant-ui/react-ai-sdk` converter routes user `file` parts OUT of a
 * message's content and exposes them as `message.attachments` instead — the
 * wire URI ends up on the attachment's first content part (the `image` field
 * for an image part, `data` for a file part). Only a `document://` URI is
 * downloadable: the content route serves stored documents. A just-sent
 * optimistic `upload://` URI (materialized to `document://` only in the
 * server-persisted copy), or anything unparseable, is inert — the raw URI is
 * carried along so the renderer can still resolve a local preview for it (the
 * staged-image cache is keyed by `upload://` URI).
 */
export type ResolvedAttachment = { kind: "document"; id: string } | { kind: "inert"; uri?: string };

/** Minimal structural view of an assistant-ui attachment content part. */
interface AttachmentContentPart {
  type: string;
  image?: string;
  data?: string;
}

export function resolveAttachmentContent(
  content: readonly AttachmentContentPart[] | undefined,
): ResolvedAttachment {
  const part = content?.[0];
  const uri = part?.type === "image" ? part.image : part?.type === "file" ? part.data : undefined;
  const id = typeof uri === "string" ? parseDocumentUri(uri) : null;
  if (id) return { kind: "document", id };
  return typeof uri === "string" ? { kind: "inert", uri } : { kind: "inert" };
}

/** Run package id from a launch result (`body.packageId`, then top-level). */
export function extractRunPackageId(result: unknown): string | undefined {
  const unwrapped = asRecord(unwrapResult(result));
  if (!unwrapped) return undefined;
  const body = asRecord(unwrapped.body);
  return (
    nonEmptyString(body?.packageId) ??
    nonEmptyString(body?.package_id) ??
    nonEmptyString(unwrapped.packageId) ??
    nonEmptyString(unwrapped.package_id)
  );
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
