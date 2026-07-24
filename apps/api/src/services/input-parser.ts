// SPDX-License-Identifier: Apache-2.0

/**
 * Request input parsing.
 *
 * The request body is always JSON. File fields carry either:
 *
 *  - `upload://upl_xxx` URIs pointing to previously staged uploads — each is
 *    streamed straight from the uploads bucket into the run workspace via the
 *    uploads service (which performs size + magic-byte MIME validation and
 *    stamps the upload's first consume); or
 *  - inline RFC 2397 `data:<mime>;name=<filename>;base64,<payload>` URIs —
 *    decoded in-request (capped at `MAX_INLINE_FILE_BYTES`), validated with
 *    the same magic-byte MIME policy, and written to the run workspace. The
 *    payload is then stripped from the input value so the persisted run input
 *    stays small. This lets JSON-only clients (MCP `invoke_operation`) run an
 *    agent with a small file input in a single call — no createUpload + signed
 *    PUT round-trips.
 *
 * Alternatively the body may carry `rerun_from: <run_id>` instead of `input`.
 * Staged uploads are rewritten to durable `document://` URIs in persisted run
 * input, so replay resolves the same documents without an upload-retention
 * dependency.
 *
 * Either way the run ends up with a `FileReference` (metadata only — no
 * buffer) per document on the parsed input.
 */

import type { Context } from "hono";
import { fileTypeStream, fileTypeFromBuffer } from "file-type";
import type { FileReference } from "./run-launcher/types.ts";
import { isFileField, type JSONSchemaObject, type JSONSchema7 } from "@appstrate/core/form";
import { validateInput } from "./schema.ts";
import {
  invalidRequest,
  notFound,
  conflict,
  payloadTooLarge,
  validationFailed,
  documentCountExceeded,
} from "../lib/errors.ts";
import {
  consumeUploadStream,
  peekUploads,
  parseUploadUri,
  isUnsniffableMime,
  sniffedMimeMatchesDeclared,
  normalizeMime,
  type UploadMeta,
} from "./uploads.ts";
import { getRun } from "./state/runs.ts";
import {
  getDocumentForActor,
  streamDocumentContent,
  assertWithinDocumentLimits,
  type PendingUploadMaterialization,
} from "./documents.ts";
import {
  isUploadUri,
  isDocumentUri,
  parseDocumentUri,
  documentUri,
} from "@appstrate/core/document-uri";
import { getActor, tryGetActor } from "../lib/actor.ts";
import { prefixedId } from "../lib/ids.ts";
import { VERSION_SELECTOR_DRAFT } from "./agent-version-resolver.ts";
import { isValidRange } from "@appstrate/core/semver";
import { isValidDistTag, isProtectedTag } from "@appstrate/core/dist-tags";
import {
  streamRunDocument,
  writeRunDocumentsManifest,
  deleteRunDocuments,
} from "./run-workspace-storage.ts";
import { assignWorkspaceNames } from "./run-document-naming.ts";
import { getEnv } from "@appstrate/env";

export interface ParsedInput {
  input?: Record<string, unknown>;
  uploadedFiles?: FileReference[];
  /** Per-run model override (wire field `modelId` on the request body). */
  modelIdOverride?: string;
  /** Per-run proxy override (wire field `proxyId` on the request body). */
  proxyIdOverride?: string;
  /**
   * Per-run config override (wire field `config` on the request body).
   * Deep-merged with `application_packages.config` before the run is
   * executed (see `deepMergeConfig` in `@appstrate/core/schema-validation`).
   * Mirrors the OpenAI Assistants `runs.create { instructions, model, tools }`
   * and Argo Workflows `submitOptions.parameters` SOTA: the merge happens
   * server-side so UI / CLI / SDK clients all reach the same resolved config
   * for the same `(persisted, override)` pair.
   *
   * Internal output names use the `*Override` suffix to match the schedule
   * wire (`configOverride / modelIdOverride / proxyIdOverride / versionOverride`)
   * and the run-record column (`runs.config_override`).
   */
  configOverride?: Record<string, unknown>;
  /**
   * Per-integration connection picks for THIS run (#199).
   * Wire field `connectionOverrides` on the request body; flows into the
   * resolver's mechanism #2 and is persisted on `runs.connection_overrides`.
   * Flat shape: `{ "<integrationId>": "<connectionId>" }` — one connection
   * per integration; the chosen connection carries its own authKey.
   */
  connectionOverrides?: Record<string, string>;
  /**
   * Per-run dependency version overrides (#666). Wire field
   * `dependency_overrides`; flows into `buildAgentPackage` and is persisted
   * on `runs.dependency_overrides`. Flat shape:
   * `{ "@scope/skill": "draft" | "<semver|dist-tag>" }`. `"draft"` opts that
   * dependency out of the published-only resolution (the skill edit loop);
   * any other value replaces the manifest pin for that dependency.
   */
  dependencyOverrides?: Record<string, string>;
  /**
   * Staged uploads consumed by this run that must be materialized into durable
   * `documents` rows once the run row exists (D1). The persisted `input`
   * already carries the rewritten `document://<documentId>` URIs; the row
   * insert is deferred to `prepareAndExecuteRun` (after `createRun`) because
   * `documents.run_id` is a hard FK. Empty/undefined for runs with no uploads.
   */
  pendingDocuments?: PendingUploadMaterialization[];
  /**
   * The `document://` ids this run consumes as input (D1 chaining protection).
   * Passed into `createRun`, which locks and revalidates every document before
   * inserting the run and its `document_links` rows in one transaction. Every
   * resolved `document://` input ref qualifies: a brand-new run is never a
   * doc's own container. Undefined when the run consumes no documents.
   */
  consumedDocumentIds?: string[];
}

interface RunRequestBody {
  input?: Record<string, unknown>;
  /**
   * Run id whose persisted `input` to replay verbatim on this run (wire field
   * `rerun_from`, mutually exclusive with `input`). Consumed staged uploads
   * are persisted as durable `document://` URIs, so a cancelled (or completed)
   * run can be re-triggered with the same documents and different overrides
   * (`modelId`, `config`, `?version`) in one call, no re-upload and no
   * dependency on upload retention.
   */
  rerun_from?: string;
  modelId?: string;
  proxyId?: string;
  config?: Record<string, unknown>;
  connection_overrides?: Record<string, string>;
  dependency_overrides?: Record<string, string>;
}

/**
 * A run-scoped dependency override value is valid when it is the literal
 * `draft` selector OR a resolvable version spec (semver range / exact version
 * via `isValidRange`, or a dist-tag name). The other protected tag names
 * (`published`, `latest`) carry no per-dependency override meaning — they can
 * never be created as real dist-tags (`isProtectedTag`), so accepting them here
 * would let a value 400 should reject sail through the gate and die later as a
 * confusing 422. Reject them syntactically so the caller gets a clean 400.
 * Deep "does this version exist" checks happen at resolution time (422
 * `dependency_unresolved`); this is the cheap syntactic gate.
 */
export function isValidDependencyOverride(value: string): boolean {
  if (value === VERSION_SELECTOR_DRAFT) return true;
  if (isProtectedTag(value)) return false;
  return isValidRange(value) || isValidDistTag(value);
}

/** Validate `input` against the manifest schema, throwing `validationFailed` (422). */
function assertInputValid(input: Record<string, unknown>, inputSchema: JSONSchemaObject): void {
  const inputValidation = validateInput(input, inputSchema);
  if (!inputValidation.valid) {
    throw validationFailed(
      inputValidation.errors.map((e) => ({
        field: e.field ? `input.${e.field}` : "input",
        code: "invalid_input",
        title: "Invalid Input",
        message: e.message,
      })),
    );
  }
}

function getArrayItems(prop: JSONSchema7): JSONSchema7 | undefined {
  if (!prop.items || typeof prop.items === "boolean") return undefined;
  if (Array.isArray(prop.items)) {
    const first = prop.items[0];
    return typeof first === "object" ? first : undefined;
  }
  return prop.items;
}

/** Is this value an inline RFC 2397 data URI? */
export function isDataUri(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:");
}

/**
 * Reference to one file value found in the run input. `kind` dispatches the
 * materialization path (staged upload vs inline data URI); `index` is set for
 * entries of array file fields so the inline path can rewrite the exact
 * persisted value after extraction.
 */
export interface InputFileRef {
  fieldName: string;
  uri: string;
  kind: "upload" | "data" | "document";
  index?: number;
}

function toFileRef(key: string, value: unknown, index?: number): InputFileRef {
  if (isUploadUri(value)) {
    return {
      fieldName: key,
      uri: value,
      kind: "upload",
      ...(index !== undefined ? { index } : {}),
    };
  }
  if (isDocumentUri(value)) {
    return {
      fieldName: key,
      uri: value,
      kind: "document",
      ...(index !== undefined ? { index } : {}),
    };
  }
  if (isDataUri(value)) {
    return { fieldName: key, uri: value, kind: "data", ...(index !== undefined ? { index } : {}) };
  }
  throw invalidRequest(
    `Field '${key}' must be an 'upload://<id>' URI, a 'document://<id>' URI, or an inline ` +
      "'data:<mime>;base64,<payload>' URI",
    key,
  );
}

/**
 * Walk the schema, find file-shaped properties, and validate that each
 * matching input value is an `upload://` or `data:` URI (or an array of
 * them). Pure — exported for unit tests, has no I/O.
 */
export function collectFileRefs(
  schema: JSONSchemaObject,
  input: Record<string, unknown>,
): InputFileRef[] {
  const refs: InputFileRef[] = [];
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (!isFileField(prop)) continue;
    const value = input[key];
    if (value == null) continue;
    const isArrayField = prop.type === "array" || !!getArrayItems(prop);
    if (isArrayField) {
      if (!Array.isArray(value)) {
        throw invalidRequest(`Field '${key}' expected an array of upload or data URIs`, key);
      }
      value.forEach((v, i) => refs.push(toFileRef(key, v, i)));
    } else {
      if (Array.isArray(value)) {
        throw invalidRequest(`Field '${key}' must be a single URI, not an array`, key);
      }
      refs.push(toFileRef(key, value));
    }
  }
  return refs;
}

/**
 * The set of `document://` ids a run will actually MOUNT: those placed in a
 * DECLARED file input field (a `format:"uri"` + `contentMediaType` property in
 * the manifest input schema). Only these refs are streamed into the run
 * workspace by `collectFileRefs` / the consume path — a `document://` URI
 * dropped into any non-file field never mounts. Reuses `collectFileRefs` so the
 * file-field detection lives in exactly one place (no duplicated schema walk).
 *
 * Tolerant: returns an empty set when there is no schema or the input is not a
 * plain object. Callers pass an input that has already cleared `collectFileRefs`
 * once (post-parse), so the re-walk cannot surface a new validation error on the
 * happy path. Pure — exported for the inline-run prompt-coverage guard + tests.
 */
export function collectMountedDocumentIds(
  inputSchema: JSONSchemaObject | undefined,
  input: unknown,
): Set<string> {
  const ids = new Set<string>();
  if (!inputSchema || input === null || typeof input !== "object" || Array.isArray(input)) {
    return ids;
  }
  for (const ref of collectFileRefs(inputSchema, input as Record<string, unknown>)) {
    if (ref.kind !== "document") continue;
    const id = parseDocumentUri(ref.uri);
    if (id) ids.add(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Inline data: URIs (RFC 2397)
// ---------------------------------------------------------------------------

/**
 * Decoded ceiling for one inline `data:` URI file. Inline content rides the
 * JSON request body (global cap: `API_BODY_LIMIT_BYTES`, 10 MiB by default —
 * 4 MiB decoded ≈ 5.5 MiB of base64 leaves headroom for the rest of the
 * input). Larger files must use the staged-upload flow (`createUpload` +
 * signed PUT), which streams and never buffers in API memory.
 */
export const MAX_INLINE_FILE_BYTES = 4 * 1024 * 1024;

// Base64 ceiling derived from the decoded cap — checked BEFORE decoding so an
// oversized payload is rejected without allocating its decoded buffer.
const MAX_INLINE_BASE64_LENGTH = Math.ceil(MAX_INLINE_FILE_BYTES / 3) * 4;

// Standard base64 alphabet, after url-safe chars are folded in and padding
// stripped (see parseDataUri).
const BASE64_RE = /^[A-Za-z0-9+/]*$/;

/** A decoded inline file: declared MIME, optional declared filename, content. */
export interface InlineFile {
  mime: string;
  name?: string;
  bytes: Uint8Array;
}

/**
 * Parse + decode an inline `data:<mediatype>;name=<filename>;base64,<payload>`
 * URI (RFC 2397; `name` is the conventional filename parameter). Strict:
 * requires `;base64` (file content is binary-safe only in base64); accepts
 * standard or url-safe alphabet, padded or unpadded. Enforces the per-file
 * decoded cap. Pure —
 * exported for unit tests.
 */
export function parseDataUri(uri: string, fieldName: string): InlineFile {
  const comma = uri.indexOf(",");
  if (comma === -1) {
    throw invalidRequest(`Field '${fieldName}' data: URI is missing the ',' separator`, fieldName);
  }
  const meta = uri.slice("data:".length, comma);
  const payload = uri.slice(comma + 1);

  const params = meta.split(";");
  // RFC 2397: an omitted mediatype defaults to text/plain.
  const mime = normalizeMime(params[0] || "text/plain") || "text/plain";
  let base64 = false;
  let name: string | undefined;
  for (const param of params.slice(1)) {
    if (param === "base64") {
      base64 = true;
    } else if (param.startsWith("name=")) {
      const raw = param.slice("name=".length);
      try {
        name = decodeURIComponent(raw);
      } catch {
        name = raw;
      }
    }
    // Other mediatype parameters (charset=…) are ignored.
  }
  if (!base64) {
    throw invalidRequest(
      `Field '${fieldName}' data: URI must be base64-encoded — use 'data:<mime>;base64,<payload>'`,
      fieldName,
    );
  }
  if (payload.length > MAX_INLINE_BASE64_LENGTH) {
    throw payloadTooLarge(
      `Field '${fieldName}' inline file exceeds ${MAX_INLINE_FILE_BYTES} bytes — use the staged-upload flow (createUpload + signed PUT) for larger files`,
    );
  }
  // Accept standard and url-safe base64, padded or unpadded — MCP/LLM clients
  // (the JSON-only callers this path targets) commonly emit unpadded and/or
  // url-safe payloads. Fold `-_` → `+/`, drop trailing padding, then validate
  // the alphabet. A `length % 4 === 1` remainder is unreachable for any valid
  // base64 string, so it is the one length that signals a truncated payload.
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!BASE64_RE.test(normalized) || normalized.length % 4 === 1) {
    throw invalidRequest(`Field '${fieldName}' data: URI payload is not valid base64`, fieldName);
  }
  const bytes = new Uint8Array(Buffer.from(normalized, "base64"));
  if (bytes.byteLength === 0) {
    throw invalidRequest(`Field '${fieldName}' data: URI payload is empty`, fieldName);
  }
  if (bytes.byteLength > MAX_INLINE_FILE_BYTES) {
    throw payloadTooLarge(
      `Field '${fieldName}' inline file exceeds ${MAX_INLINE_FILE_BYTES} bytes — use the staged-upload flow (createUpload + signed PUT) for larger files`,
    );
  }
  return { mime, ...(name ? { name } : {}), bytes };
}

/** Common extensions for text-shaped MIMEs `file-type` cannot sniff. */
const MIME_EXT: Record<string, string> = {
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/html": "html",
  "application/json": "json",
  "application/xml": "xml",
  "application/x-yaml": "yaml",
  "application/yaml": "yaml",
};

/** Best-effort filename extension for a MIME type (fallback for unnamed inline files). */
function extFromMime(mime: string): string {
  const known = MIME_EXT[mime];
  if (known) return known;
  const subtype = mime.split("/")[1] ?? "";
  return /^[a-z0-9]{1,8}$/.test(subtype) ? subtype : "bin";
}

/**
 * Payload-stripped form of an inline data URI — what replaces the original
 * value in the run input before it is persisted (run record, prompt
 * templates). Keeps the run row small: the bytes live in the run workspace as
 * a document, referenced by `name`.
 */
function strippedDataUri(mime: string, docName: string): string {
  return `data:${mime};name=${encodeURIComponent(docName)};base64,`;
}

/**
 * Is this the payload-stripped marker {@link strippedDataUri} persisted in
 * place of an inline `data:` URI (empty payload + `name` parameter)? Used by
 * the `rerun_from` replay path to reject materialized inline inputs with a
 * dedicated 409 instead of letting `parseDataUri` surface a misleading
 * "payload is empty" 400. Pure — exported for unit tests.
 */
export function isStrippedInlineMarker(uri: string): boolean {
  if (!isDataUri(uri)) return false;
  const comma = uri.indexOf(",");
  // Marker shape: `data:<mime>;name=<doc>;base64,` — the comma is the last
  // character (empty payload) and the mediatype carries a `name` parameter.
  if (comma === -1 || comma !== uri.length - 1) return false;
  const params = uri.slice("data:".length, comma).split(";");
  return params.includes("base64") && params.some((p) => p.startsWith("name="));
}

/**
 * Reject when the combined size of a run's input documents exceeds the
 * per-run ceiling. Pure so it can be unit-tested without a DB or request
 * context; callers pass `getEnv().WORKSPACE_MAX_DOCS_BYTES` as the limit.
 * Throws `payloadTooLarge` (413) — a policy violation, surfaced before the
 * run launches rather than as a mid-flight failure.
 */
export function assertDocsWithinCap(files: { size: number }[], maxBytes: number): void {
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > maxBytes) {
    throw payloadTooLarge(
      `Input documents total ${total} bytes; the per-run limit is ${maxBytes} bytes`,
    );
  }
}

/**
 * Cap on how many input documents stream into the run workspace at once. Each
 * in-flight stream holds a storage-adapter buffer (~5 MiB for the S3 multipart
 * part), so an unbounded `Promise.all` over a large array-file field could pin
 * `documents × 5 MiB`. Bounding it keeps the per-run streaming memory floor flat
 * regardless of document count.
 */
const DOC_STREAM_CONCURRENCY = 4;

/**
 * Map over `items` running at most `limit` callbacks concurrently, preserving
 * input order in the result. On the first rejection, in-flight callbacks are
 * allowed to settle but no new ones start, and the rejection propagates — the
 * caller rolls back any partial work (here: the run workspace, by doc name, so
 * stragglers that finished are cleaned regardless).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let aborted = false;
  async function worker(): Promise<void> {
    while (!aborted) {
      const i = nextIndex++;
      if (i >= items.length) break;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (err) {
        aborted = true;
        throw err;
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Resolve `rerun_from` to the prior run's persisted `input` snapshot.
 *
 * Access control mirrors `GET /api/runs/:id`: the lookup is scoped to the
 * caller's org + application (cross-tenant ids surface as the same not-found
 * as a missing run), end-users can only replay their own runs, and the prior
 * run must belong to the agent being triggered (its input schema is the one
 * the replayed input was validated against). The returned input flows through
 * the exact same consume + validation pipeline as a fresh request and the JSON
 * is re-validated against the current schema.
 */
async function resolveRerunInput(
  c: Context,
  rerunFrom: unknown,
  agentPackageId: string | undefined,
): Promise<Record<string, unknown>> {
  if (typeof rerunFrom !== "string" || rerunFrom.length === 0) {
    throw invalidRequest("`rerun_from` must be a run id", "rerun_from");
  }
  const prior = await getRun(
    { orgId: c.get("orgId"), applicationId: c.get("applicationId") },
    rerunFrom,
  );
  if (!prior) {
    throw notFound(`Run '${rerunFrom}' not found`);
  }
  const endUser = c.get("endUser");
  if (endUser && prior.endUserId !== endUser.id) {
    throw notFound(`Run '${rerunFrom}' not found`);
  }
  if (agentPackageId !== undefined && prior.packageId !== agentPackageId) {
    throw conflict(
      "rerun_agent_mismatch",
      `Run '${rerunFrom}' belongs to a different agent — rerun_from can only replay runs of the agent being triggered`,
    );
  }
  const input = prior.input;
  if (input !== null && (typeof input !== "object" || Array.isArray(input))) {
    // Defensive: `runs.input` is written from a parsed object, but the column
    // is untyped jsonb — never replay a malformed snapshot.
    throw invalidRequest(`Run '${rerunFrom}' has no replayable input`, "rerun_from");
  }
  return (input as Record<string, unknown> | null) ?? {};
}

/**
 * Parse and validate the run request body. Returns parsed input + resolved
 * uploaded files. Throws `ApiError` (invalidRequest / notFound / conflict /
 * gone) on any validation or resolution failure.
 */
export async function parseRequestInput(
  c: Context,
  runId: string,
  inputSchema?: JSONSchemaObject,
  opts?: {
    /**
     * The triggered agent's package id — `rerun_from` is rejected with a 409
     * when the prior run belongs to a different agent. When omitted, the
     * same-agent gate is skipped (service-level callers that already verified
     * ownership).
     */
    agentPackageId?: string;
  },
): Promise<ParsedInput> {
  let body: RunRequestBody = {};
  try {
    const raw = await c.req.json<RunRequestBody>();
    if (raw && typeof raw === "object") body = raw;
  } catch {
    body = {};
  }

  let input = body.input ?? {};
  const isRerun = body.rerun_from !== undefined;
  if (body.rerun_from !== undefined) {
    if (body.input !== undefined) {
      throw invalidRequest(
        "`input` and `rerun_from` are mutually exclusive — the prior run's input is replayed verbatim",
        "rerun_from",
      );
    }
    input = await resolveRerunInput(c, body.rerun_from, opts?.agentPackageId);
  }
  let uploadedFiles: FileReference[] = [];
  let pendingDocuments: PendingUploadMaterialization[] = [];
  let consumedDocumentIds: string[] = [];

  if (inputSchema) {
    const refs = collectFileRefs(inputSchema, input);
    const orgId = c.get("orgId");
    const applicationId = c.get("applicationId");

    // Resolve every upload URI to an upload id up front so a malformed URI
    // fails before we touch storage.
    const resolved = refs
      .filter((ref) => ref.kind === "upload")
      .map((ref) => {
        const id = parseUploadUri(ref.uri);
        if (!id) throw invalidRequest(`Invalid upload URI '${ref.uri}'`, ref.fieldName);
        return { ref, id };
      });

    // Resolve every document URI to a document id up front (same eager-fail as
    // uploads). A `document://` reference points at an already-durable document
    // (a prior materialized upload or an agent output); it is streamed into the
    // run workspace like an upload but never re-materialized.
    const docRefs = refs
      .filter((ref) => ref.kind === "document")
      .map((ref) => {
        const id = parseDocumentUri(ref.uri);
        if (!id) throw invalidRequest(`Invalid document URI '${ref.uri}'`, ref.fieldName);
        return { ref, id };
      });

    // Every resolved `document://` input ref is a consumption link (D1): the run
    // is brand-new, so it is never any of these docs' own container. Persisted as
    // `document_links` atomically with `createRun`, protecting the doc from its
    // producer's deletion. The ACL check below still gates the run itself.
    consumedDocumentIds = docRefs.map(({ id }) => id);

    // Decode inline data: URIs up front — the per-file cap is enforced inside
    // parseDataUri (pre-decode on the base64 length, post-decode on the bytes),
    // so a malformed or oversized inline file also fails before any streaming.
    const inline = refs
      .filter((ref) => ref.kind === "data")
      .map((ref) => {
        // A replayed input carries the payload-stripped marker where the
        // original inline bytes used to be (the bytes were materialized
        // into the PRIOR run's workspace and stripped from the persisted
        // input — see strippedDataUri). There is nothing to replay:
        // surface a dedicated 409 instead of parseDataUri's misleading
        // "payload is empty" 400.
        if (isRerun && isStrippedInlineMarker(ref.uri)) {
          throw conflict(
            "rerun_inline_input_unavailable",
            `Field '${ref.fieldName}' was provided as an inline data: URI on the original run — ` +
              "inline inputs are materialized into the run workspace and stripped from the stored " +
              "input, so they cannot be replayed via rerun_from. Re-send the file in `input` " +
              "(staged upload:// references are converted to durable document:// references).",
          );
        }
        return { ref, file: parseDataUri(ref.uri, ref.fieldName) };
      });

    // Document object names — set once uploads are streamed, used to roll the
    // run workspace back if anything below the stream fails. Empty until we
    // stream, so a pre-stream failure (bad URI, cap, peek) rolls back nothing.
    let docNames: string[] = [];
    try {
      if (resolved.length > 0 || inline.length > 0 || docRefs.length > 0) {
        // Bound the NUMBER of input documents a single run may carry (uploads +
        // inline + document:// refs) — the byte caps below do not bound the
        // COUNT (thousands of tiny files). Rejected before any streaming.
        const totalInputDocs = resolved.length + inline.length + docRefs.length;
        if (totalInputDocs > getEnv().RUN_MAX_DOCUMENTS) {
          throw documentCountExceeded(
            `A run may carry at most ${getEnv().RUN_MAX_DOCUMENTS} input documents (got ${totalInputDocs})`,
          );
        }

        // The run-triggering actor — resolved once and threaded into both the
        // document ACL check AND the upload ownership gate (peek/consume), so a
        // member can only deliver documents/uploads they may read. The document
        // ACL REQUIRES a principal (strict `getActor`); the upload ownership gate
        // scopes leniently (`tryGetActor` → tenant-only when absent), so
        // upload/inline-only inputs never hard-require a principal in context.
        const actor =
          docRefs.length > 0 ? getActor(c) : resolved.length > 0 ? tryGetActor(c) : undefined;

        // Resolve every `document://` reference through the container ACL (D2):
        // the run-triggering actor must be able to read the document, else it is
        // indistinguishable from missing (404 — covers cross-org and cross-app).
        const resolvedDocs =
          docRefs.length > 0
            ? await Promise.all(
                docRefs.map(async ({ ref, id }) => {
                  const doc = await getDocumentForActor({ orgId, applicationId }, actor!, id);
                  // Cross-actor ACL (S2): resolving a run is org-wide-visible to
                  // members, but a `user_upload` is creator-only content — a
                  // member must not deliver another member's private upload into
                  // their own run. The `download` capability is always true for
                  // an `agent_output` (freely chainable, D6) but only for the
                  // creator of an upload. A rejected ref is indistinguishable from
                  // missing (404), matching the not-found shape above.
                  if (!doc || !doc.capabilities.download)
                    throw notFound(`Document '${id}' not found`);
                  return { ref, doc: doc.row };
                }),
              )
            : [];

        // Bound the total input-document payload on DECLARED sizes BEFORE
        // streaming any bytes. Documents are delivered to the agent out-of-band
        // (fetched + streamed to disk), so an oversized payload is a policy
        // violation rather than a crash. The per-file `bytes === size` check
        // inside consume keeps each actual size ≤ its declared size, so a
        // declared total under the cap bounds the actual total too. Inline
        // files count their already-decoded (exact) size; `document://`
        // references count their stored size. Reject before launch so the
        // caller gets a clean 413 instead of a mid-flight run failure.
        const metas: Map<string, UploadMeta> =
          resolved.length > 0
            ? await peekUploads(
                resolved.map((r) => r.id),
                { orgId, applicationId, actor },
              )
            : new Map();
        assertDocsWithinCap(
          [
            ...metas.values(),
            ...inline.map((i) => ({ size: i.file.bytes.byteLength })),
            ...resolvedDocs.map(({ doc }) => ({ size: doc.size })),
          ],
          getEnv().WORKSPACE_MAX_DOCS_BYTES,
        );

        // Documents quota + per-file cap on the uploads that will be
        // materialized into durable rows (D1) — a SYNCHRONOUS reject BEFORE the
        // run is created, so an over-quota / over-cap run 403/413s here rather
        // than after `createRun`. `createDocumentFromUpload` re-checks the exact
        // bytes inside its transaction. `document://` inputs are already durable
        // (their bytes were counted at creation) so they are not re-counted.
        if (resolved.length > 0) {
          await assertWithinDocumentLimits(
            orgId,
            resolved.map((r) => metas.get(r.id)!.size),
          );
        }

        // Inline files: sniff the magic bytes once — used both for the
        // declared-vs-actual MIME check (same policy as the staged-upload
        // consume path) and as the extension source for unnamed files.
        const inlineSniffed = await Promise.all(
          inline.map(({ file }) => fileTypeFromBuffer(file.bytes)),
        );
        inline.forEach(({ ref, file }, i) => {
          const sniffed = inlineSniffed[i]?.mime;
          if (file.mime !== "application/octet-stream" && !isUnsniffableMime(file.mime)) {
            if (!sniffedMimeMatchesDeclared(file.mime, sniffed)) {
              throw invalidRequest(
                sniffed
                  ? `Field '${ref.fieldName}' inline content type '${sniffed}' does not match declared '${file.mime}'`
                  : `Field '${ref.fieldName}' inline content does not match declared mime '${file.mime}'`,
                ref.fieldName,
              );
            }
          }
        });

        // Separate each document's DISPLAY name (its human name) from its
        // WORKSPACE name (the unique single-segment filename written into the
        // run container). Unnamed inline files derive a display name from their
        // field (array entries get an index suffix). `assignWorkspaceNames`
        // then deterministically resolves any display-name collision so two
        // documents never overwrite each other on disk — `report.pdf`,
        // `report-2.pdf`, … The ordered list [uploads, inline, documents] is
        // the single source of truth for provisioning, the manifest, and the
        // prompt path (see run-document-naming.ts).
        const uploadDisplayNames = resolved.map(({ id }) => metas.get(id)!.name);
        const inlineDisplayNames = inline.map(({ ref, file }, i) => {
          if (file.name) return file.name;
          const ext = inlineSniffed[i]?.ext ?? extFromMime(file.mime);
          const suffix = ref.index !== undefined ? `-${ref.index}` : "";
          return `${ref.fieldName}${suffix}.${ext}`;
        });
        const documentDisplayNames = resolvedDocs.map(({ doc }) => doc.name);
        const workspaceNames = assignWorkspaceNames([
          ...uploadDisplayNames,
          ...inlineDisplayNames,
          ...documentDisplayNames,
        ]);
        const uploadWorkspaceNames = workspaceNames.slice(0, resolved.length);
        const inlineWorkspaceNames = workspaceNames.slice(
          resolved.length,
          resolved.length + inline.length,
        );
        const documentWorkspaceNames = workspaceNames.slice(resolved.length + inline.length);
        // Storage keys for rollback — the workspace names are the on-disk /
        // object-store segments (`{runId}/documents/<workspaceName>`).
        docNames = workspaceNames;

        // Stream each upload straight from the uploads bucket into the run
        // workspace — validating size + MIME on the fly — so the platform never
        // buffers a whole document in memory. Bounded concurrency keeps the
        // streaming memory floor flat regardless of document count.
        const consumed = await mapWithConcurrency(
          resolved,
          DOC_STREAM_CONCURRENCY,
          async ({ ref, id }, i) => {
            const docName = uploadWorkspaceNames[i]!;
            const declaredSize = metas.get(id)!.size;
            // Sink: sniff the head, count bytes, and pipe everything to the run
            // workspace. `fileTypeStream` re-emits the full stream and exposes
            // `.fileType` once the head has been read — available after the pipe
            // drains. The counting passthrough yields the size the size-check
            // (and manifest) needs.
            const meta = await consumeUploadStream(
              id,
              { orgId, applicationId, actor },
              async (src) => {
                const detection = await fileTypeStream(src);
                let bytes = 0;
                // Hash the streamed bytes too, so consume can compare against a
                // client-declared upload sha256 and reject a mismatch at this
                // FIRST consume (fails fast, before the run is created).
                const hasher = new Bun.CryptoHasher("sha256");
                const counter = new TransformStream<Uint8Array, Uint8Array>({
                  transform(chunk, controller) {
                    bytes += chunk.byteLength;
                    // Abort the moment the stream overshoots the declared size,
                    // rather than copying a declared-small / uploaded-huge object
                    // into the run workspace in full just to delete it after the
                    // post-drain size check. Errors the stream → the S3 multipart
                    // upload aborts (or the FS write stops) → consume releases the
                    // claim and the run workspace is rolled back. The post-drain
                    // `bytes === size` check in consume still catches the
                    // under-size case (and is the correctness backstop for any
                    // sink that does not abort early).
                    if (bytes > declaredSize) {
                      controller.error(
                        invalidRequest(
                          `Upload '${id}' size mismatch: declared ${declaredSize} bytes, exceeded mid-stream`,
                        ),
                      );
                      return;
                    }
                    hasher.update(chunk);
                    controller.enqueue(chunk);
                  },
                });
                await streamRunDocument(runId, docName, detection.pipeThrough(counter));
                return {
                  bytes,
                  sniffedMime: detection.fileType?.mime,
                  sha256: hasher.digest("hex"),
                };
              },
            );
            return {
              fieldName: ref.fieldName,
              name: meta.name,
              workspaceName: docName,
              type: meta.mime,
              size: meta.size,
            };
          },
        );

        // Inline files are small (≤ MAX_INLINE_FILE_BYTES) and already decoded
        // in memory — write them to the run workspace sequentially.
        const inlined: FileReference[] = [];
        for (let i = 0; i < inline.length; i++) {
          const { ref, file } = inline[i]!;
          const docName = inlineWorkspaceNames[i]!;
          await streamRunDocument(runId, docName, new Blob([file.bytes]).stream());
          inlined.push({
            fieldName: ref.fieldName,
            name: inlineDisplayNames[i]!,
            workspaceName: docName,
            type: file.mime,
            size: file.bytes.byteLength,
          });
        }

        // Stream each `document://` reference straight from the durable
        // documents bucket into the run workspace (same path as uploads — the
        // runtime is unchanged). No re-materialization: the document already
        // exists and its bytes were validated when it was created.
        const documentFiles: FileReference[] = [];
        for (let j = 0; j < resolvedDocs.length; j++) {
          const { ref, doc } = resolvedDocs[j]!;
          const docName = documentWorkspaceNames[j]!;
          const src = await streamDocumentContent(doc.storageKey);
          if (!src) throw notFound(`Document '${doc.id}' content is missing`);
          await streamRunDocument(runId, docName, src);
          documentFiles.push({
            fieldName: ref.fieldName,
            name: doc.name,
            workspaceName: docName,
            type: doc.mime,
            size: doc.size,
          });
        }

        // Strip the inline payloads from the input now that the bytes live in
        // the run workspace — the persisted run input (run record, prompt
        // templates) keeps a compact `data:<mime>;name=<doc>;base64,` marker
        // instead of megabytes of base64.
        for (let i = 0; i < inline.length; i++) {
          const { ref, file } = inline[i]!;
          const marker = strippedDataUri(file.mime, inlineWorkspaceNames[i]!);
          if (ref.index === undefined) {
            input[ref.fieldName] = marker;
          } else {
            (input[ref.fieldName] as unknown[])[ref.index] = marker;
          }
        }

        // Materialization (D1): each consumed upload becomes a durable
        // `documents` row. Mint the id now, rewrite the persisted input value
        // `upload://upl_x` → `document://doc_y` (durable source of truth — a
        // rerun re-resolves the document, no upload retention window needed),
        // and defer the row insert to `prepareAndExecuteRun` (after `createRun`,
        // because `documents.run_id` is a hard FK).
        pendingDocuments = resolved.map(({ ref, id }) => {
          const documentId = prefixedId("doc");
          const uri = documentUri(documentId);
          if (ref.index === undefined) {
            input[ref.fieldName] = uri;
          } else {
            (input[ref.fieldName] as unknown[])[ref.index] = uri;
          }
          return { uploadId: id, documentId };
        });

        // Write the documents manifest once every document has streamed — it
        // doubles as the agent's enumeration index and the run-workspace
        // deletion index on teardown.
        const allFiles = [...consumed, ...inlined, ...documentFiles];
        await writeRunDocumentsManifest(
          runId,
          allFiles.map((d) => ({ name: d.name, workspace_name: d.workspaceName, size: d.size })),
        );

        uploadedFiles = allFiles;
      }

      // Validate the JSON input shape — once, whether or not the run carries
      // documents. A failure here still rolls back any streamed documents.
      assertInputValid(input, inputSchema);
    } catch (err) {
      if (docNames.length > 0) await deleteRunDocuments(runId, docNames);
      throw err;
    }
  }

  // `config` in the body is a partial override that is *deep-merged* with
  // `application_packages.config` by the run route. We pass it through as
  // an opaque object — validation against the manifest schema runs after
  // the merge so a client can omit keys the persisted state already
  // satisfies.
  //
  // Reject `null` explicitly: at top-level the merge short-circuits on a
  // falsy override (`null` would silently inherit defaults) which conflicts
  // with the schedule-update semantics where `null` clears the override.
  // Force callers to pick: omit `config` to inherit defaults, send `{}` for
  // an explicit empty override, send a populated object for a real override.
  if (
    body.config !== undefined &&
    (body.config === null || typeof body.config !== "object" || Array.isArray(body.config))
  ) {
    throw invalidRequest(
      "`config` must be a JSON object — omit the field to inherit persisted defaults",
      "config",
    );
  }

  // `connection_overrides` shape guard. Flat map: integrationId → connectionId.
  // Invalid bodies produce a 400 with a precise param so the picker UI can
  // highlight the offender.
  if (body.connection_overrides !== undefined) {
    if (
      body.connection_overrides === null ||
      typeof body.connection_overrides !== "object" ||
      Array.isArray(body.connection_overrides)
    ) {
      throw invalidRequest("`connection_overrides` must be a JSON object", "connection_overrides");
    }
    for (const [intId, connId] of Object.entries(body.connection_overrides)) {
      if (typeof connId !== "string" || connId.length === 0) {
        throw invalidRequest(
          `\`connection_overrides["${intId}"]\` must be a non-empty connection id`,
          `connection_overrides.${intId}`,
        );
      }
    }
  }

  // `dependency_overrides` shape + value guard (#666). Flat map:
  // packageId → "draft" | "<semver|dist-tag>". Each value must be a valid
  // run-scoped override so a typo'd pin 400s here instead of silently doing
  // nothing — the per-dependency analogue of the `connection_overrides` gate.
  if (body.dependency_overrides !== undefined) {
    if (
      body.dependency_overrides === null ||
      typeof body.dependency_overrides !== "object" ||
      Array.isArray(body.dependency_overrides)
    ) {
      throw invalidRequest("`dependency_overrides` must be a JSON object", "dependency_overrides");
    }
    for (const [depId, spec] of Object.entries(body.dependency_overrides)) {
      if (typeof spec !== "string" || !isValidDependencyOverride(spec)) {
        throw invalidRequest(
          `\`dependency_overrides["${depId}"]\` must be "draft" or a valid version spec (semver range or dist-tag)`,
          `dependency_overrides.${depId}`,
        );
      }
    }
  }

  // An empty `{}` carries no override — collapse it to `undefined` so it
  // persists as NULL on `runs.dependency_overrides`. A non-null map on the run
  // object signals "consumed an override (maybe draft) → not reproducible from
  // version_ref alone"; an empty object would muddy that signal for free.
  const dependencyOverrides =
    body.dependency_overrides && Object.keys(body.dependency_overrides).length > 0
      ? body.dependency_overrides
      : undefined;

  // An effectively-empty input (no fields, no files) carries no information —
  // collapse it to `undefined` so it persists as SQL NULL on `runs.input`,
  // keeping every trigger origin (agent route, inline run, schedule) on one
  // representation instead of splitting `{}` vs NULL by code path. This holds
  // for a `rerun_from` replay of an already-empty input too: replaying nothing
  // means the same thing. No reader distinguishes `{}` from NULL — the prompt
  // builder normalizes both to `{}` (run-context-builder), the run DTO hides
  // the input card for both (run-info-tab), and `resolveRerunInput` coalesces
  // NULL back to `{}` on the next replay.
  const normalizedInput = Object.keys(input).length > 0 ? input : undefined;

  return {
    input: normalizedInput,
    uploadedFiles: uploadedFiles.length > 0 ? uploadedFiles : undefined,
    pendingDocuments: pendingDocuments.length > 0 ? pendingDocuments : undefined,
    consumedDocumentIds: consumedDocumentIds.length > 0 ? consumedDocumentIds : undefined,
    modelIdOverride: body.modelId,
    proxyIdOverride: body.proxyId,
    configOverride: body.config,
    connectionOverrides: body.connection_overrides,
    dependencyOverrides,
  };
}
