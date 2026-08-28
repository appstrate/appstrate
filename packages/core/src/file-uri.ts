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
 * ever written under the old scheme addresses a `doc_` id, and
 * {@link FILE_ID_RE} accepts only `file_`. So the pair `document://` +
 * `file_xxx` — the only thing the accept-path could still have matched — is a
 * form nothing has ever emitted, and a genuine `document://doc_xxx` fails on
 * the id, not the scheme. One spelling is read and one is written, and they
 * are the same one.
 *
 * The row id prefix is `file_`, minted by `prefixedId("file")`. It was `doc_`
 * until the rename was finished at the physical layer; nothing reads the old
 * spelling any more, which is exactly why the old scheme has nothing left to
 * address.
 *
 * Dependency-free on purpose (no DB/storage imports) so the MCP tool layer,
 * the chat module, and the runtime can import it without pulling in the files
 * service's graph.
 */

/** `appfile://file_xxx` — the opaque, stable URI form of a stored file. */
export const FILE_URI_PREFIX = "appfile://";

/**
 * The `run_logs.event` tag that announces a published file
 * (`type='result' event='file'`).
 *
 * The single agreement point between the sink that WRITES the tag and the two
 * readers that filter on it (the web shell's run page, the chat module's run
 * card), so the literal is spelled once and none of the three can drift from
 * the others.
 */
export const PUBLISHED_FILE_LOG_EVENT = "file";

/**
 * `files.purpose` of a file an agent published from a run. The other purposes
 * (`user_upload`, …) mark a file that came from somewhere else.
 *
 * Its one in-repo reader is {@link isFileProducedByRun}, below — a dead-export
 * scan therefore reports the `export`, never the constant. The `export` is not
 * decoration: the value sites that should adopt it are `apps/api`'s files
 * service and the chat module's run reconciler, which still spell the literal.
 *
 * The SPA deliberately does NOT adopt it. Every `"agent_output"` in `apps/web`
 * is a member of the two-value wire enum in TYPE position
 * (`"user_upload" | "agent_output"` in `lib/files.ts` and `hooks/use-files.ts`),
 * an i18n key suffix in the gallery filter domain
 * (`components/file-list-panel.tsx`, where `files:filter.<value>` is looked up
 * and `"all"` sits beside the two wire values), a generated `api/schema.d.ts`,
 * or a test fixture asserting the wire value. In all four, swapping one member
 * for a constant while its sibling stays a literal reads worse than the pair —
 * there is no `USER_UPLOAD_FILE_PURPOSE`, and adding one would be new published
 * surface duplicating `filePurposeValues` (`packages/db/src/schema/enums.ts`),
 * which is where the vocabulary is actually declared once and from which the
 * DB enum, the OpenAPI enum and the SPA's generated types all derive.
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
export const FILE_ID_RE = /^file_[A-Za-z0-9_-]{8,}$/;

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
 * Scans a free-form text blob for an embedded stored-file URI. `file_` + ≥1 id
 * char keeps the boundary scan permissive, with the strict `{8,}` length
 * enforced by {@link parseFileUri}.
 */
const EMBEDDED_FILE_URI_SCAN = /appfile:\/\/file_[A-Za-z0-9_-]+/g;

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
