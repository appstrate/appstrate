// SPDX-License-Identifier: Apache-2.0

/**
 * Request input parsing.
 *
 * The request body is always JSON. File fields carry `upload://upl_xxx` URIs
 * that point to previously staged uploads. Each URI is streamed straight from
 * the uploads bucket into the run workspace via the uploads service (which
 * performs size + magic-byte MIME validation and marks the upload as consumed),
 * leaving a `FileReference` (metadata only — no buffer) on the parsed input.
 */

import type { Context } from "hono";
import { fileTypeStream } from "file-type";
import type { FileReference } from "./run-launcher/types.ts";
import { isFileField, type JSONSchemaObject, type JSONSchema7 } from "@appstrate/core/form";
import { validateInput } from "./schema.ts";
import { invalidRequest, payloadTooLarge, validationFailed } from "../lib/errors.ts";
import { consumeUploadStream, peekUploads, isUploadUri, parseUploadUri } from "./uploads.ts";
import { sanitizeStorageKey } from "./file-storage.ts";
import {
  streamRunDocument,
  writeRunDocumentsManifest,
  deleteRunDocuments,
} from "./run-workspace-storage.ts";
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
}

interface RunRequestBody {
  input?: Record<string, unknown>;
  modelId?: string;
  proxyId?: string;
  config?: Record<string, unknown>;
  connection_overrides?: Record<string, string>;
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

/**
 * Walk the schema, find file-shaped properties, and validate that each
 * matching input value is an `upload://` URI (or an array of them). Pure —
 * exported for unit tests, has no I/O.
 */
export function collectUploadRefs(
  schema: JSONSchemaObject,
  input: Record<string, unknown>,
): { fieldName: string; uri: string }[] {
  const refs: { fieldName: string; uri: string }[] = [];
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (!isFileField(prop)) continue;
    const value = input[key];
    if (value == null) continue;
    const isArrayField = prop.type === "array" || !!getArrayItems(prop);
    if (isArrayField) {
      if (!Array.isArray(value)) {
        throw invalidRequest(`Field '${key}' expected an array of upload URIs`, key);
      }
      for (const v of value) {
        if (!isUploadUri(v)) {
          throw invalidRequest(`Field '${key}' entries must be 'upload://<id>' URIs`, key);
        }
        refs.push({ fieldName: key, uri: v });
      }
    } else {
      if (!isUploadUri(value)) {
        throw invalidRequest(`Field '${key}' must be an 'upload://<id>' URI`, key);
      }
      refs.push({ fieldName: key, uri: value });
    }
  }
  return refs;
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
 * Parse and validate the run request body. Returns parsed input + resolved
 * uploaded files. Throws `ApiError` (invalidRequest / notFound) on any
 * validation or resolution failure.
 */
export async function parseRequestInput(
  c: Context,
  runId: string,
  inputSchema?: JSONSchemaObject,
): Promise<ParsedInput> {
  let body: RunRequestBody = {};
  try {
    const raw = await c.req.json<RunRequestBody>();
    if (raw && typeof raw === "object") body = raw;
  } catch {
    body = {};
  }
  const input = body.input ?? {};
  let uploadedFiles: FileReference[] = [];

  if (inputSchema) {
    const refs = collectUploadRefs(inputSchema, input);
    const orgId = c.get("orgId");
    const applicationId = c.get("applicationId");

    // Resolve every URI to an upload id up front so a malformed URI fails before
    // we touch storage.
    const resolved = refs.map((ref) => {
      const id = parseUploadUri(ref.uri);
      if (!id) throw invalidRequest(`Invalid upload URI '${ref.uri}'`, ref.fieldName);
      return { ref, id };
    });

    // Document object names — set once uploads are streamed, used to roll the
    // run workspace back if anything below the stream fails. Empty until we
    // stream, so a pre-stream failure (bad URI, cap, peek) rolls back nothing.
    let docNames: string[] = [];
    try {
      if (resolved.length > 0) {
        // Bound the total input-document payload on DECLARED sizes BEFORE
        // streaming any bytes. Documents are delivered to the agent out-of-band
        // (fetched + streamed to disk), so an oversized payload is a policy
        // violation rather than a crash. The per-file `bytes === size` check
        // inside consume keeps each actual size ≤ its declared size, so a
        // declared total under the cap bounds the actual total too. Reject
        // before launch so the caller gets a clean 413 instead of a mid-flight
        // run failure.
        const metas = await peekUploads(
          resolved.map((r) => r.id),
          { orgId, applicationId },
        );
        assertDocsWithinCap([...metas.values()], getEnv().WORKSPACE_MAX_DOCS_BYTES);

        // The run-workspace document object name. Must match the path the
        // prompt-builder hands the agent (`./documents/<sanitizeStorageKey(name)>`)
        // and the manifest entry the agent fetches by.
        docNames = resolved.map(({ id }) => sanitizeStorageKey(metas.get(id)!.name));

        // Stream each upload straight from the uploads bucket into the run
        // workspace — validating size + MIME on the fly — so the platform never
        // buffers a whole document in memory. Bounded concurrency keeps the
        // streaming memory floor flat regardless of document count.
        const consumed = await mapWithConcurrency(
          resolved,
          DOC_STREAM_CONCURRENCY,
          async ({ ref, id }, i) => {
            const docName = docNames[i]!;
            const declaredSize = metas.get(id)!.size;
            // Sink: sniff the head, count bytes, and pipe everything to the run
            // workspace. `fileTypeStream` re-emits the full stream and exposes
            // `.fileType` once the head has been read — available after the pipe
            // drains. The counting passthrough yields the size the size-check
            // (and manifest) needs.
            const meta = await consumeUploadStream(id, { orgId, applicationId }, async (src) => {
              const detection = await fileTypeStream(src);
              let bytes = 0;
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
                  controller.enqueue(chunk);
                },
              });
              await streamRunDocument(runId, docName, detection.pipeThrough(counter));
              return { bytes, sniffedMime: detection.fileType?.mime };
            });
            return { fieldName: ref.fieldName, name: meta.name, type: meta.mime, size: meta.size };
          },
        );

        // Write the documents manifest once every document has streamed — it
        // doubles as the agent's enumeration index and the run-workspace
        // deletion index on teardown.
        await writeRunDocumentsManifest(
          runId,
          consumed.map((d, i) => ({ name: docNames[i]!, size: d.size })),
        );

        uploadedFiles = consumed;
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

  return {
    input,
    uploadedFiles: uploadedFiles.length > 0 ? uploadedFiles : undefined,
    modelIdOverride: body.modelId,
    proxyIdOverride: body.proxyId,
    configOverride: body.config,
    connectionOverrides: body.connection_overrides,
  };
}
