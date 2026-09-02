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
 * `@appstrate/shared-types` realtime schemas: we only need a handful of
 * fields, so we redeclare them and stay decoupled from the API wire module.
 * Field names match the wire shape (post-camelize) exactly so a server
 * payload validates unchanged.
 */

import { z } from "zod";
import { runStatusValues, TERMINAL_RUN_STATUSES } from "@appstrate/db/run-status";
import {
  fileUri,
  isFileProducedByRun,
  parseFileUri,
  PUBLISHED_FILE_LOG_EVENT,
} from "@appstrate/core/file-uri";
import { asRecord, unwrapResult } from "./tool-result.ts";

/** Operation ids whose result launches a run we can follow. */
const RUN_LAUNCH_OPS = ["runAgent", "runInline", "run_and_wait"] as const;
type RunLaunchOp = (typeof RUN_LAUNCH_OPS)[number];
export type RunStatus = (typeof runStatusValues)[number];

export function isTerminalStatus(status: string | null | undefined): status is RunStatus {
  return typeof status === "string" && TERMINAL_RUN_STATUSES.has(status as RunStatus);
}

/**
 * Whether `useRunLogStream` should open the live SSE tail for a run.
 *
 * A card mounted with a TERMINAL `initialStatus` (a `run_and_wait` result, or a
 * reopened conversation whose launch card carries the final status) has nothing
 * to tail: the run will never emit another log line or `run_update`, and a
 * stream would only cost a connection, a second 1000-row log sweep and a
 * duplicate `/api/files` read on the snapshot frame. Without a tail the
 * one-shot `/api/runs/:id` read owns the completion signal (it handles
 * `!willTail && terminal`), so the evidence rule (`shouldRaiseSweepDone`) is
 * the same either way.
 *
 * `hasSseContext` is "an SSE URL could be built AND `EventSource` exists".
 */
export function shouldOpenLiveTail(args: {
  initialStatus: string | null | undefined;
  hasSseContext: boolean;
}): boolean {
  return args.hasSseContext && !isTerminalStatus(args.initialStatus);
}

/**
 * Automatic artefacts belong to a call that mounted live, never to completed
 * history. Capture this result once at card mount; later phase changes must not
 * revoke a live card's eligibility before its final file event arrives.
 */
export function isRunAutoPresentEligible(
  phase: "pending" | "running" | "success" | "error",
  initialStatus: string | null | undefined,
): boolean {
  return (phase === "pending" || phase === "running") && !isTerminalStatus(initialStatus);
}

/**
 * i18n key for the settled line a terminal run's card shows instead of its last
 * log. A KEY, not a sentence: this module ships no literal user-facing text —
 * the card resolves it through the host translator (same pattern as the web
 * shell's `artifactFailureCodeKey`). An unknown/absent status falls back to the
 * generic "finished" key, so a new status can never render a raw key.
 */
export function runStatusLineKey(status: RunStatus | undefined): string {
  switch (status) {
    case "success":
    case "failed":
    case "timeout":
    case "cancelled":
      return `run.status.${status}`;
    default:
      return "run.status.done";
  }
}

/** Is this op-id one whose result we can mine for a launched run id? */
export function isRunLaunchOp(opId: string | undefined): opId is RunLaunchOp {
  return !!opId && (RUN_LAUNCH_OPS as readonly string[]).includes(opId);
}

/**
 * Minimal log-line shape shared by the SSE `run_log` frame and the
 * `GET /runs/:id/logs` list rows — both carry the same `run_logs` columns
 * (the SSE event adds org/space ids we ignore). `level` is open-coded rather
 * than enum'd so a future level can't drop a line; `data` may be a record,
 * the literal `"[payload too large]"`, or absent (non-verbose subscribers).
 */
const runLogLineSchema = z.object({
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
const runUpdateLiteSchema = z.object({
  id: z.string().optional(),
  status: z.string(),
  packageId: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  duration: z.number().nullable().optional(),
});
type RunUpdateLite = z.infer<typeof runUpdateLiteSchema>;

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
  // Same lifecycle subset as a `run_update` frame. Zod strips every other key,
  // so a server still sending retired fields (`primary_document_id`) parses
  // unchanged — they are ignored, never asserted away.
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
 * Build the per-run SSE URL. Returns `undefined` when org/space context is
 * missing (the caller then renders the static card instead of live run progress).
 * `verbose=true` is REQUIRED: the server strips `run_log.data` for non-verbose
 * subscribers, so without it the panel would show empty lines.
 */
export function buildRunSseUrl(args: {
  runId: string;
  orgId: string | undefined;
  spaceId: string | undefined;
}): string | undefined {
  const { runId, orgId, spaceId } = args;
  if (!orgId || !spaceId) return undefined;
  const qs = new URLSearchParams({
    orgId,
    spaceId,
    verbose: "true",
  });
  return `/api/realtime/runs/${encodeURIComponent(runId)}?${qs.toString()}`;
}

/** Read org/space ids out of the chat host's forwarded headers (case-tolerant). */
export function orgSpaceFromHeaders(headers: Record<string, string> | undefined): {
  orgId: string | undefined;
  spaceId: string | undefined;
} {
  const h = headers ?? {};
  return {
    orgId: h["X-Org-Id"] ?? h["x-org-id"],
    spaceId: h["X-Space-Id"] ?? h["x-space-id"],
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
 * `type='progress'` but keep `event='progress'`), nor `output`/`file`/system
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
 * A file surfaced in a run card: the stable id + uri (for chaining) plus a
 * display name. `mime`/`size` are optional (present in the persisted tool
 * result, absent on some log frames).
 */
export interface ChatRunFile {
  id: string;
  uri: string;
  name: string;
  mime?: string;
  size?: number;
}

/**
 * Display name AND download filename for a file that carries none. The sink
 * writes `name: null` whenever the emitter omitted it
 * (`appstrate-event-sink.ts` → `file.published`), so a nameless frame is
 * reachable, not hypothetical. Dropping such a frame would be the worse
 * failure by far: the count of produced files IS the auto-present rule, so one
 * missing file turns a two-file run into a single-file run and opens the wrong
 * thing. A chip with a generic label still opens, still downloads, and — once
 * the run is terminal — is relabelled by the authoritative `/api/files` read.
 *
 * Exported and shared by every nameless-file site in the module (the run-card
 * chips, the thread's sent-attachment chips, the model-facing attachment line,
 * the run-notice code span) — the fallback WAS hand-written at six of them,
 * which is how the same file could read `file` on the card and something else
 * in the thread.
 *
 * NOT translated, deliberately, and that is load-bearing at
 * `fileActivation`: this same string becomes the name the browser saves the
 * download under, so a localized value would save the file as
 * «Fichier sans nom» for one reader and something else for the next. The chip
 * LABEL is a different question and gets `t("file.previewOf" | "file.downloadOf")`
 * with the translated `file.unnamed` placeholder inside it; `file.unnamed`
 * ("ce fichier") is a sentence fragment for that interpolation, not a name a
 * chip can wear on its own.
 */
export const UNNAMED_FILE = "file";

function asChatRunFile(raw: unknown): ChatRunFile | undefined {
  const r = asRecord(raw);
  if (!r) return undefined;
  // `id` in the tool result; `file_id` in the `file.published` log frame. The
  // pre-#1177 `document_id` spelling is no longer read: no persisted frame
  // carries it.
  const id = nonEmptyString(r.id) ?? nonEmptyString(r.file_id);
  const uri = nonEmptyString(r.uri) ?? (id ? fileUri(id) : undefined);
  const name = nonEmptyString(r.name) ?? UNNAMED_FILE;
  if (!id || !uri) return undefined;
  const file: ChatRunFile = { id, uri, name };
  const mime = nonEmptyString(r.mime);
  if (mime) file.mime = mime;
  if (typeof r.size === "number") file.size = r.size;
  return file;
}

/**
 * The published file list of a persisted `run_and_wait` result. The tool
 * writes it under `files`, and that is the only key read.
 *
 * The pre-#1177 `documents` spelling used to be accepted here as well, on the
 * grounds that this payload IS the reload-safe source (it exists precisely
 * because run logs get pruned). It is gone with the rest of the rename: no
 * persisted result carries it.
 */
function rawFileList(record: Record<string, unknown> | null | undefined): unknown[] | undefined {
  const value = record?.files;
  return Array.isArray(value) ? value : undefined;
}

/**
 * Pull the published file list out of a persisted run_and_wait tool result (at
 * the top level, or nested under the invoke envelope's `body`; under either
 * accepted key). Empty when the run produced none — survives reload because it
 * reads the persisted message part, not live state.
 */
export function extractRunFiles(result: unknown): ChatRunFile[] {
  const unwrapped = asRecord(unwrapResult(result));
  if (!unwrapped) return [];
  const raw = rawFileList(unwrapped) ?? rawFileList(asRecord(unwrapped.body)) ?? [];
  const out: ChatRunFile[] = [];
  for (const item of raw) {
    const file = asChatRunFile(item);
    if (file) out.push(file);
  }
  return out;
}

/**
 * Extract published files from the live run log stream — the
 * `type='result' event='file'` frames the sink persists for each
 * `file.published` event. Lets the card show a chip the moment an agent
 * publishes, before the run terminates. No pre-#1177 `event='document'` frame
 * is read — that spelling is gone with the rest of the rename.
 *
 * These frames are publications, i.e. files the agent PRODUCED: the only
 * emitters are the `publish_file` runtime tool and the end-of-run
 * `outputs/` sweep. Input files a run merely consumed never appear here, so
 * this list is exactly the population the auto-present rule counts.
 *
 * Historical frames carry extra fields (notably the retired `presentation`);
 * only the known keys are read, so a legacy line parses like any other.
 */
export function publishedFilesFromLogs(logs: readonly RunLogLine[]): ChatRunFile[] {
  const out: ChatRunFile[] = [];
  for (const line of logs) {
    if (line.event !== PUBLISHED_FILE_LOG_EVENT) continue;
    if (!line.data || typeof line.data !== "object") continue;
    const file = asChatRunFile(line.data);
    if (file) out.push(file);
  }
  return out;
}

/**
 * One page of `GET /api/files?run_id=…&purpose=agent_output`, narrowed to what
 * this run PRODUCED.
 */
interface ProducedFileList {
  /** The rows on this page that this run produced. */
  files: ChatRunFile[];
  /**
   * The server holds rows beyond this page (`hasMore` on the list envelope).
   * The route clamps `limit` to 100 and exposes no cursor field — paging is
   * `startingAfter=<last id>` — so a run that produced more than 100 files is
   * silently truncated here unless the caller says so.
   *
   * This does NOT endanger the auto-present rule: a truncated page holds at
   * least 100 entries, never exactly 1, so {@link autoPresentFile} answers
   * `undefined` either way. It is a display concern only — do not build a
   * pager for it.
   */
  hasMore: boolean;
}

/**
 * The run's produced files, read from `GET /api/files?run_id=…` — the same
 * endpoint (and the same predicate) the run page's Outcome pane uses. This is
 * the AUTHORITATIVE set: the log stream is a truncatable window
 * (`?limit=1000`, ascending, cursor never followed), and the end-of-run
 * `file.published` frames are the last rows a run writes, so a chatty run
 * pushes exactly the frames this card needs out of the page.
 *
 * Returns `undefined` — NOT an empty page — when `payload` is not a list
 * envelope at all (an error body, a truncated response, anything unparseable).
 * The two are opposite kinds of answer and the completion signal turns on
 * telling them apart: an envelope listing zero rows is a run that produced
 * nothing, which is a complete answer; a body that is not an envelope is no
 * answer at all. See {@link shouldRaiseSweepDone}.
 *
 * Which rows count is `isFileProducedByRun` (`@appstrate/core/file-uri`), the
 * one predicate the run page's Outcome pane and the server-side
 * `run_and_wait` payload also read — a package may not import from
 * `apps/web`, but all three can import core.
 */
export function producedFilesFromFileList(
  payload: unknown,
  runId: string,
): ProducedFileList | undefined {
  const envelope = asRecord(payload);
  const rows = envelope?.data;
  if (!Array.isArray(rows)) return undefined;
  const out: ChatRunFile[] = [];
  for (const row of rows) {
    const r = asRecord(row);
    if (!r) continue;
    if (!isFileProducedByRun(r, runId)) continue;
    const file = asChatRunFile(r);
    if (file) out.push(file);
  }
  return { files: out, hasMore: envelope?.hasMore === true };
}

/**
 * How one of the reads the completion signal depends on turned out.
 * `"not-attempted"` is not a failure: it says this settle path never claimed
 * that read in the first place.
 */
export type SweepRead = "ok" | "failed" | "not-attempted";

/**
 * Should `sweepDone` — "this run's produced-file set is complete and
 * trustworthy" — be raised, given how the reads that back the claim turned out?
 *
 * The invariant, and the whole reason this is a function and not an inlined
 * `finally`: **no evidence, no flag; and no flag means nothing is presented,
 * never an error and never a spinner.** A read that merely FINISHED is not
 * evidence — the previous shape swallowed a 500 from `/api/files` and raised
 * the flag anyway, which is how a two-file run whose second publication frame
 * fell outside the log window auto-opened the first of its two files.
 *
 *  - `status` must be terminal: `sweepDone` says the read finished, the status
 *    says the run is over. Both are required.
 *  - `producedFileRead` must be `"ok"`: the response was 2xx AND the payload
 *    parsed as the list envelope. An envelope listing ZERO files IS `"ok"` —
 *    a run that produced nothing is a legitimate, complete answer.
 *  - `logSweep` blocks only when it was attempted and FAILED. The card's set is
 *    the UNION of the log frames and the authoritative read, and the
 *    authoritative half alone already covers everything the run produced, so a
 *    frame the sweep missed can only delay a chip, never remove one. But a
 *    sweep that errored yields `[]`, which is indistinguishable from "this run
 *    wrote no frames", and the tail path attempts one precisely because frames
 *    can land in the same tick as the terminal status. Withholding there costs
 *    nothing (no flag ⇒ nothing presented, card unchanged) and is the only
 *    reading that keeps "no evidence, no flag" literal. The no-tail path never
 *    attempts a final sweep and reports `"not-attempted"`.
 */
export function shouldRaiseSweepDone(args: {
  status: string | null | undefined;
  producedFileRead: SweepRead;
  logSweep: SweepRead;
}): boolean {
  if (!isTerminalStatus(args.status)) return false;
  if (args.producedFileRead !== "ok") return false;
  return args.logSweep !== "failed";
}

/**
 * The derived auto-present rule (issue #1177). Nothing the agent declares takes
 * part in it: the run either produced exactly ONE file — which is then opened
 * for the user — or it did not, and the card just lists what there is.
 *
 *  - 0 produced files  → nothing to present.
 *  - exactly 1         → that one.
 *  - N > 1             → nothing; the user picks from the chips.
 *
 * Gated on a SETTLED run because a run that publishes three files emits them one
 * at a time: a mid-stream count of 1 is not the final count, and opening on it
 * would auto-present the first of three.
 *
 * "Settled" is asserted by a POSITIVE signal, `sweepDone` — raised by
 * `useRunLogStream` only after it has actually completed a full read of the
 * run's produced-file set (final log sweep + the authoritative
 * `GET /api/files` read). The absence of a live tail is NOT that signal and
 * must not be used as one: the hook's `live` starts `false` and only turns true
 * on the SSE handshake, which loses a race against the two plain GETs the same
 * effect fires, and stays false forever when no SSE can be opened at all. Under
 * a `!live` gate both cases read as "settled" on a set nothing ever completed.
 *
 * Terminal status is still required on top: `sweepDone` says the read finished,
 * the status says the run is over.
 */
export function autoPresentFile(args: {
  files: readonly ChatRunFile[];
  status: RunStatus | undefined;
  sweepDone: boolean;
}): ChatRunFile | undefined {
  if (!isTerminalStatus(args.status) || !args.sweepDone) return undefined;
  return args.files.length === 1 ? args.files[0] : undefined;
}

/**
 * Merge two regular file lists, deduping by id while letting newer display
 * metadata win. Every produced file is the same kind of thing — there is no
 * featured/secondary distinction to project.
 */
export function mergeRunFiles(a: readonly ChatRunFile[], b: readonly ChatRunFile[]): ChatRunFile[] {
  const byId = new Map<string, ChatRunFile>();
  for (const file of [...a, ...b]) {
    const previous = byId.get(file.id);
    byId.set(file.id, previous ? { ...previous, ...file } : file);
  }
  return [...byId.values()];
}

/**
 * An attachment's resolved content: a downloadable stored file, or an inert
 * placeholder.
 *
 * The `@assistant-ui/react-ai-sdk` converter routes user `file` parts OUT of a
 * message's content and exposes them as `message.attachments` instead — the
 * wire URI ends up on the attachment's first content part (the `image` field
 * for an image part, `data` for a file part). Only an `appfile://` URI is
 * downloadable: the content route serves stored files. A just-sent
 * optimistic `upload://` URI (materialized to `appfile://` only in the
 * server-persisted copy), or anything unparseable, is inert — the raw URI is
 * carried along so the renderer can still resolve a local preview for it (the
 * staged-image cache is keyed by `upload://` URI).
 */
type ResolvedAttachment = { kind: "file"; id: string } | { kind: "inert"; uri?: string };

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
  const id = typeof uri === "string" ? parseFileUri(uri) : null;
  if (id) return { kind: "file", id };
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
