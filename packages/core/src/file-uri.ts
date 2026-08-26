// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `appfile://` (and companion `upload://`) URI contract.
 *
 * The durable file store addresses every stored file by an opaque, stable
 * `appfile://file_xxx` URI; a staged (not-yet-materialized) upload carries the
 * ephemeral `upload://upl_xxx` form. Both the platform (apps/api files/uploads
 * services + MCP router) and the chat module validate/parse these URIs, so the
 * pure, dependency-free helpers live here — one source of truth for the prefix
 * + id shape — rather than being re-implemented per consumer (the earlier
 * state: four near-identical copies of the prefix literals and id regex).
 *
 * ## Why `appfile://` and not `file://`
 *
 * `file://` is already taken: it means the local filesystem, and MCP uses it
 * for local resources. An opaque platform id under that scheme is ambiguous to
 * the model and to every MCP client, so the platform claims its own scheme.
 *
 * ## Why the pre-#1177 `document://` spelling is NOT read
 *
 * The scheme was `document://` until issue #1177, and it was kept parseable
 * afterwards so historical `runs.input` rows, persisted chat attachments and
 * model-authored prompts stayed resolvable. That compatibility became
 * unreachable when the rename was finished at the physical layer: every URI
 * ever written under the old scheme addresses a `doc_` id. Only the SCHEME is
 * unread: `document://` is never parsed, while the `doc_` ID it addressed is
 * still perfectly live and {@link FILE_ID_RE} accepts it.
 *
 * That distinction was lost once, expensively. An earlier revision of this
 * header asserted the row id prefix "was `doc_` until the rename was finished
 * at the physical layer" and concluded the old spelling had nothing left to
 * address. The physical rename never touched `files.id` — 0043 renamed the
 * table, 0044 rewrote `storage_key`, and no migration rewrites the id — so on
 * production every row was still `doc_`, and a validator that accepted only
 * `file_` 404'd all of them. Write the ids, not the intent.
 *
 * New rows mint `file_` via `prefixedId("file")`; `doc_` is read-only history.
 *
 * Dependency-free on purpose (no DB/storage imports) so the MCP tool layer,
 * the chat module, and the runtime can import it without pulling in the files
 * service's graph.
 */

/** `appfile://file_xxx` — the opaque, stable URI form of a stored file. */
export const FILE_URI_PREFIX = "appfile://";

/**
 * The `run_logs.event` tag the sink WRITES to announce a published file
 * (`type='result' event='file'`).
 *
 * Exported separately from the reader-side set below so the writer consumes the
 * same value instead of spelling the literal: the set called itself "the
 * agreement point three readers share", but the one party that produces the tag
 * was not reading it. A shared list the writer does not consume is two copies
 * wearing one name.
 */
export const PUBLISHED_FILE_LOG_EVENT = "file";

/**
 * Every `run_logs.event` tag that announces a published file — the set readers
 * filter on. Derived from {@link PUBLISHED_FILE_LOG_EVENT}, so writer and
 * readers cannot disagree.
 *
 * It used to carry the pre-#1177 `"document"` spelling as well, because a
 * `run_logs` row is immutable once written and every release up to
 * `v1.0.0-beta.51` wrote that tag. It is gone with the rest of the rename: no
 * row carrying it exists any more. A deployment that somehow held one would
 * render that row without its file attachment — not an error, just an absence.
 *
 * @deprecated One tag remains, so every reader now compares against
 * {@link PUBLISHED_FILE_LOG_EVENT} directly and this list has no in-repo
 * consumer. It stays exported only because `@appstrate/core` is published:
 * removing it is a breaking change. Delete at the next major.
 */
export const PUBLISHED_FILE_LOG_EVENTS: readonly string[] = [PUBLISHED_FILE_LOG_EVENT];

/**
 * `files.purpose` of a file an agent published from a run. The other purposes
 * (`user_upload`, …) mark a file that came from somewhere else.
 */
export const AGENT_OUTPUT_FILE_PURPOSE = "agent_output";

/**
 * Was this file row PRODUCED by the given run, as opposed to merely consumed
 * by it?
 *
 * Both halves are load-bearing and NEITHER alone is enough. A file row carries
 * two independent facts: `purpose` says who created it, `run_id` says which
 * run it is anchored to.
 *
 * - `purpose` alone is wrong because `GET /api/files?run_id=X` deliberately
 *   answers the run's whole CONTAINER: it ORs `files.run_id = X` with the ids
 *   extracted from `runs.input`, so a file chained in from an earlier run via
 *   `appfile://` is listed there while still carrying `purpose: "agent_output"`
 *   — it was produced by that earlier run, and is an INPUT to this one.
 * - `run_id` alone is wrong because an upload made FOR this run is committed
 *   with `purpose: "user_upload"` AND that run's id
 *   (`apps/api/src/services/files.ts`), so matching the id alone would call the
 *   run's own input an output.
 *
 * Lives here, beside {@link PUBLISHED_FILE_LOG_EVENT}, for the same reason:
 * three independent readers — the web shell's run page, the chat module's run
 * card, and the server-side `run_and_wait` payload — must answer this question
 * identically, and a package may not import from `apps/web`. Values are read
 * as `unknown` so a raw JSON row can be tested without being narrowed first.
 */
export function isFileProducedByRun(
  file: { purpose?: unknown; run_id?: unknown },
  runId: string,
): boolean {
  return file.purpose === AGENT_OUTPUT_FILE_PURPOSE && file.run_id === runId;
}

/** `upload://upl_xxx` — the ephemeral URI form of a staged (not-yet-materialized) upload. */
export const UPLOAD_URI_PREFIX = "upload://";

/**
 * Strict file id shape: `file_` + ≥8 id chars. `prefixedId("file")` is well
 * above this, so the bound is safely below the real minimum. Rejects malformed
 * input before it reaches any database SELECT. Mirrors the service-side
 * validator (`apps/api/src/services/files.ts`).
 */
/**
 * Accepts `doc_` as well as `file_`, and that is not a courtesy — it is the
 * only prefix production rows actually carry.
 *
 * The prose above this file claimed "the row id prefix is `file_` … it was
 * `doc_` until the rename was finished at the physical layer". That premise was
 * false. 0043 renamed the TABLE (`ALTER TABLE documents RENAME TO files`) and
 * 0044 rewrote `storage_key`; NEITHER touched `files.id`, and no other
 * migration does. Measured on production the day 0044 shipped: 521 rows with a
 * `doc_` id, 0 with `file_`, plus 25 `file_links.file_id` pointing at them.
 *
 * Because `loadFileForPreview` and `resolveFileForActor`
 * (`apps/api/src/services/files.ts`) test this regex BEFORE any SELECT, a
 * `doc_` id returned null without ever reaching the database — so every
 * pre-rename file 404'd on preview and download at once.
 *
 * Widened rather than migrating the ids: the id is opaque, and its prefix is
 * read by nothing but this validator. Rewriting it would mean rewriting 521
 * ids, 25 foreign keys, 521 `storage_key` values that embed the id in their
 * path, and MOVING 521 storage objects a second time — all to change a string
 * nobody parses. The one thing that could have forced a rewrite is a persisted
 * `appfile://doc_…` reference, and there are none (measured: 0 rows in
 * `runs.input`).
 *
 * New rows mint `file_` via `prefixedId("file")`. `doc_` is frozen history: it
 * is never written again, only read.
 */
export const FILE_ID_RE = /^(?:file|doc)_[A-Za-z0-9_-]{8,}$/;

/** Strict upload id shape: `upl_` + ≥8 id chars. Mirrors the uploads service validator. */
export const UPLOAD_ID_RE = /^upl_[A-Za-z0-9_-]{8,}$/;

/** Is this value an `appfile://…` reference (prefix only, id not validated)? */
export function isFileUri(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(FILE_URI_PREFIX);
}

/** Is this value an `upload://…` reference (prefix only, id not validated)? */
export function isUploadUri(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(UPLOAD_URI_PREFIX);
}

/**
 * Does `value` carry an accepted chat-attachment scheme (`upload://` or
 * `appfile://`)? Attachments flow only through the file store, never inline
 * (`data:`) or as arbitrary URLs.
 */
export function isAttachmentUri(value: unknown): value is string {
  return isUploadUri(value) || isFileUri(value);
}

/**
 * Extract the file id from an `appfile://file_xxx` URI, validating the id
 * shape. Returns null if the prefix is absent or the id is malformed.
 */
export function parseFileUri(uri: string): string | null {
  if (typeof uri !== "string" || !uri.startsWith(FILE_URI_PREFIX)) return null;
  const id = uri.slice(FILE_URI_PREFIX.length);
  return FILE_ID_RE.test(id) ? id : null;
}

/**
 * Scans a free-form text blob for an embedded stored-file URI. The prefix
 * alternation + ≥1 id char keeps the boundary scan permissive, with the strict
 * `{8,}` length enforced by {@link parseFileUri}.
 *
 * `doc_` is matched here for the same reason {@link FILE_ID_RE} accepts it:
 * {@link fileUri} is a bare concatenation, so a pre-rename row yields
 * `appfile://doc_…`. A scan that matched only `file_` would silently drop every
 * such reference from a prompt or a run's `input` — the callers
 * (`inline-run.ts`, `files.ts`, `state/runs.ts`) treat "not found" as "not
 * referenced". No production row carries one today, but attaching any existing
 * file to a run mints one.
 */
const EMBEDDED_FILE_URI_SCAN = /appfile:\/\/(?:file|doc)_[A-Za-z0-9_-]+/g;

/** The canonical `appfile://` URI for a file id. */
export function fileUri(id: string): string {
  return `${FILE_URI_PREFIX}${id}`;
}

/**
 * Walk an arbitrary JSON value (a run's persisted `input`, tool args, …) and
 * collect the set of file ids referenced by any `appfile://file_xxx` string
 * anywhere within it — nested objects and arrays
 * included. De-duplicated, insertion-order stable. Every candidate string is
 * validated through {@link parseFileUri}, so a malformed URI is silently
 * skipped (never yields a bogus id). Pure and dependency-free — the single
 * place that turns a blob of input JSON into the file ids it consumes (e.g. so
 * a run's file listing can surface the inputs it was launched with, not only
 * the outputs it produced).
 */
export function extractFileIds(value: unknown): string[] {
  const ids = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      const id = parseFileUri(node);
      if (id) ids.add(id);
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else if (node !== null && typeof node === "object") {
      for (const item of Object.values(node)) walk(item);
    }
  };
  walk(value);
  return [...ids];
}

/**
 * Finds `appfile://file_xxx` occurrences embedded
 * ANYWHERE inside a free-form text blob (e.g. a model-authored run prompt) —
 * not only when the whole string is a bare URI, which is all
 * {@link extractFileIds} matches on a leaf string. Each candidate is
 * re-validated through {@link parseFileUri}, so a too-short / malformed id
 * after the scheme is silently skipped. De-duplicated, insertion-order stable.
 *
 * Companion to {@link extractFileIds}: that one turns structured input JSON
 * into the file ids it consumes; this one turns prose into the file ids it
 * *mentions* — the difference the inline-run guard uses to catch a URI pasted
 * into a sub-agent's prompt (inert — the runtime cannot fetch it) instead of
 * passed through a declared input file field (mounted into the workspace).
 */
export function extractFileIdsFromText(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const ids = new Set<string>();
  for (const match of text.matchAll(EMBEDDED_FILE_URI_SCAN)) {
    const id = parseFileUri(match[0]);
    if (id) ids.add(id);
  }
  return [...ids];
}
