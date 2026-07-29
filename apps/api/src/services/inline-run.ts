// SPDX-License-Identifier: Apache-2.0

/**
 * Inline-run shadow-package lifecycle.
 *
 * A POST /api/runs/inline request creates a transient `packages` row with
 * `ephemeral = true`, then feeds it through the existing run pipeline. The
 * shadow row is hidden from every user-facing catalog query
 * (notEphemeralFilter), never installed in applications, and eventually
 * compacted (manifest/prompt NULLed) by the retention worker.
 *
 * Shadow IDs use the reserved `@inline/r-<hex>` format so they remain
 * visually distinct in logs, external observability, and accidental
 * catalog queries. Collisions are prevented by the 128-bit UUID payload.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, runs } from "@appstrate/db/schema";
import type { AgentManifest, LoadedPackage } from "../types/index.ts";
import type { Actor } from "../lib/actor.ts";
import { logger } from "../lib/logger.ts";
import type { InlineRunBody, InlineRunPreflightResult } from "./inline-run-preflight.ts";
import { collectMountedDocumentIds, type ParsedInput } from "./input-parser.ts";
import { prepareAndExecuteRun } from "./run-pipeline.ts";
import { assertExplicitModelExists } from "./org-models.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import {
  documentUri,
  extractDocumentIdsFromText,
  isDocumentUri,
  parseDocumentUri,
} from "@appstrate/core/document-uri";
import { asJSONSchemaObject, type JSONSchemaObject } from "@appstrate/core/form";
import { invalidRequest, validationFailed } from "../lib/errors.ts";

export type { InlineRunBody };

/** Reserved scope for inline-run shadow packages. Never publishable. */
export const INLINE_SHADOW_SCOPE = "inline";

/**
 * Return true when the package id belongs to the reserved inline scope.
 * Cheap string test — no DB. Use this to decorate run events (e.g. webhook
 * `packageEphemeral`) without a `packages` lookup. Accepts null so callers
 * can pass `runs.package_id` directly without narrowing — a deleted-agent
 * run is treated as non-inline (the row was never an inline shadow if it
 * had a real package_id at INSERT time).
 */
export function isInlineShadowPackageId(packageId: string | null): boolean {
  return packageId !== null && packageId.startsWith(`@${INLINE_SHADOW_SCOPE}/`);
}

/**
 * Generate a unique shadow package ID. The `r-` prefix keeps the slug
 * component starting with a letter (defensive against any future tightening
 * of `SLUG_PATTERN`) while the UUID payload makes collisions negligible.
 */
export function generateShadowPackageId(): string {
  // UUID is always a valid slug suffix: [0-9a-f-]+, starts with hex.
  return `@${INLINE_SHADOW_SCOPE}/r-${crypto.randomUUID()}`;
}

export interface InsertShadowPackageParams {
  orgId: string;
  createdBy: string | null;
  manifest: AgentManifest;
  prompt: string;
}

/**
 * Insert a shadow package row with `ephemeral = true`. Returns the row id.
 *
 * The ID is generated here (not by the caller) so the caller can focus on
 * validation + pipeline dispatch. On the vanishingly rare UUID collision
 * (~1 per 2^64 inserts at 128 bits) we surface a clean error and leave the
 * retry decision to the client — no in-process retry loop.
 */
export async function insertShadowPackage(params: InsertShadowPackageParams): Promise<string> {
  const { orgId, createdBy, manifest, prompt } = params;
  const id = generateShadowPackageId();

  try {
    await db.insert(packages).values({
      id,
      orgId,
      type: "agent",
      source: "local",
      ephemeral: true,
      draftManifest: manifest as unknown as Record<string, unknown>,
      draftContent: prompt,
      createdBy,
      autoInstalled: false,
    });
  } catch (err) {
    // 23505 = unique_violation. Extremely unlikely with a 128-bit UUID, but
    // surface a clean error instead of an opaque FK/PK message.
    if (err instanceof Error && "code" in err && (err as { code: string }).code === "23505") {
      throw new Error("Shadow package id collision — retry the request.");
    }
    throw err;
  }

  logger.debug("Inline shadow package inserted", { id, orgId });
  return id;
}

/**
 * Build a `LoadedPackage` from an already-inserted shadow row.
 *
 * A definition is its manifest + prompt. The declared skills are projected off
 * the manifest wherever they are needed (readiness gate; `RunPackageCatalog`
 * for the container bundle), so nothing derived has to be threaded in here.
 */
export function buildShadowLoadedPackage(
  id: string,
  manifest: AgentManifest,
  prompt: string,
): LoadedPackage {
  return { id, manifest, prompt, source: "local" };
}

/**
 * Reject an inline run whose model-authored `prompt` references `document://`
 * URIs the run cannot actually read.
 *
 * A run only receives a document when the manifest declares a file input field
 * AND the `document://` URI is passed through the top-level `input` in THAT
 * field — the platform then streams the file into the workspace under
 * `documents/`. A `document://` URI merely pasted into the sub-agent's prompt
 * text — or dropped into a non-file input field — is inert: the runtime has no
 * way to fetch it, so the run launches against dead URIs and the sub-agent
 * silently sees nothing. The chat model has been observed doing exactly this.
 * Fail loudly with a recoverable 400 that names the offending URIs and the exact
 * fix, so the chat model self-corrects (its prompt already retries recoverable
 * field-validation errors) instead of shipping silent garbage.
 *
 * The covered set is therefore the mounted document ids only —
 * `collectMountedDocumentIds`, which walks the DECLARED file fields
 * (`format:"uri"` + `contentMediaType`) via the same `collectFileRefs` logic the
 * consume path uses — not every `document://` string anywhere in the input JSON.
 * A URI in a plain string field counts as uncovered because it never mounts.
 *
 * `document://` only, by design: this runs AFTER `parseRequestInput`, which has
 * already rewritten any `upload://` input to a fresh `document://` id the model
 * never saw — so a symmetric `upload://` prompt-vs-input comparison would
 * false-positive on a correctly-declared upload field. There is also no
 * core-level canonical `upload://` text-scanner to reuse (the upload parser
 * lives in the apps/api uploads service), and the observed live failure is
 * `document://` URIs. Pure — exported for unit tests.
 */
export function assertPromptDocumentsCoveredByInput(
  prompt: string,
  input: unknown,
  inputSchema: JSONSchemaObject | undefined,
): void {
  const uncovered = uncoveredPromptDocumentIds(prompt, input, inputSchema);
  if (uncovered.length === 0) return;
  throw promptDocumentsNotMountedError(uncovered);
}

/**
 * The `document://` ids a prompt names that the resolved input does NOT mount.
 * Pure, no I/O — the detection primitive behind
 * {@link assertPromptDocumentsCoveredByInput}.
 */
function uncoveredPromptDocumentIds(
  prompt: string,
  input: unknown,
  inputSchema: JSONSchemaObject | undefined,
): string[] {
  const promptIds = extractDocumentIdsFromText(prompt);
  if (promptIds.length === 0) return [];
  const covered = collectMountedDocumentIds(inputSchema, input);
  return promptIds.filter((id) => !covered.has(id));
}

/** The recoverable 400 for prompt-named documents the run cannot be given. */
function promptDocumentsNotMountedError(documentIds: readonly string[]): Error {
  return validationFailed([
    {
      field: "prompt",
      code: "document_uri_in_prompt",
      title: "Document URI In Prompt",
      message:
        "The run prompt references document:// URIs the caller cannot read, so they cannot be " +
        "mounted into the run. Pass only document:// URIs you have access to — either in " +
        "`context_documents` or through a file input field declared in manifest.input.schema " +
        '({"type":"string","format":"uri","contentMediaType":"<mime>"}). Unresolvable: ' +
        documentIds.map(documentUri).join(", "),
    },
  ]);
}

// ---------------------------------------------------------------------------
// Reserved context-documents field (fan-in by reference)
// ---------------------------------------------------------------------------

/**
 * Reserved input-field name the platform synthesizes on an INLINE manifest to
 * mount caller-named `document://` URIs into the run's `documents/` directory.
 *
 * Reserved means: a caller-supplied manifest (or input) that already declares it
 * is rejected with a 400 rather than silently overwritten — the platform owns
 * this name. Inline only: a cataloged agent's `input.schema` is a versioned
 * contract and is never rewritten.
 */
export const CONTEXT_DOCUMENTS_FIELD = "_context_documents";

/**
 * The synthesized property. The wildcard media range on `contentMediaType` is
 * what makes the field a FILE field for the whole platform: `isFileField`
 * (`@appstrate/afps-shared/file-field`) only tests `contentMediaType != null` and
 * never inspects the value, so the wildcard needs zero changes to the shared
 * predicate or to any of its consumers (SchemaForm, apps/api, afps-runtime). A
 * fan-in mixes json/md/csv/… so no single media type would do, and nothing
 * downstream compares a `document://` input's real MIME against the declared
 * `contentMediaType` (the magic-byte sniff covers `upload://` and `data:` only;
 * `validateInput` excludes file fields from AJV entirely).
 */
function contextDocumentsProperty(): Record<string, unknown> {
  return {
    type: "array",
    description:
      "Platform-managed: document:// URIs mounted read-only into ./documents/ for this run.",
    items: { type: "string", format: "uri", contentMediaType: "*/*" },
  };
}

/**
 * Reject a caller-supplied inline manifest / input that uses the reserved
 * {@link CONTEXT_DOCUMENTS_FIELD} name. Never overwrite caller data silently —
 * a collision is a 400 the caller can act on by renaming their field.
 */
export function assertContextDocumentsFieldAvailable(manifest: unknown, input: unknown): void {
  const properties = manifestInputProperties(manifest);
  if (properties && CONTEXT_DOCUMENTS_FIELD in properties) {
    throw invalidRequest(
      `'${CONTEXT_DOCUMENTS_FIELD}' is a reserved input field name — rename the property in ` +
        "manifest.input.schema and pass your document:// URIs in `context_documents` instead.",
      `manifest.input.schema.properties.${CONTEXT_DOCUMENTS_FIELD}`,
    );
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    if (CONTEXT_DOCUMENTS_FIELD in (input as Record<string, unknown>)) {
      throw invalidRequest(
        `'${CONTEXT_DOCUMENTS_FIELD}' is a reserved input field name — pass your document:// ` +
          "URIs in the top-level `context_documents` argument instead.",
        `input.${CONTEXT_DOCUMENTS_FIELD}`,
      );
    }
  }
}

/**
 * The `properties` map of an inline manifest's input schema, when it has one.
 * Takes `unknown` so the reserved-name guard can run against a raw request
 * manifest (the validate endpoint) as well as a parsed one.
 */
function manifestInputProperties(manifest: unknown): Record<string, unknown> | undefined {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return undefined;
  const input = (manifest as { input?: unknown }).input;
  if (!input || typeof input !== "object") return undefined;
  const schema = (input as { schema?: unknown }).schema;
  if (!schema || typeof schema !== "object") return undefined;
  const properties = (schema as { properties?: unknown }).properties;
  return properties && typeof properties === "object" && !Array.isArray(properties)
    ? (properties as Record<string, unknown>)
    : undefined;
}

/** Result of {@link injectContextDocuments}. */
export interface ContextDocumentsInjection {
  /** Manifest with the reserved field declared. Unchanged when there is nothing to mount. */
  manifest: AgentManifest;
  /**
   * Input patch to merge into the request input (`parseRequestInput`'s
   * `injectedInput`). `undefined` when there is nothing to mount.
   */
  inputPatch: Record<string, unknown> | undefined;
}

/**
 * THE single synthesis point for context documents (B2): the caller's explicit
 * `context_documents` argument reduces to one list of `document://` URIs, so
 * there is exactly one place that knows the field shape.
 *
 * Declaring the field is all the work: from here the URIs travel the NORMAL
 * file-ref path (`collectFileRefs` → `getDocumentForActor` ACL → byte/count caps
 * → stream into `documents/` → `document_links`), and the platform prompt
 * announces them like any other input document. Nothing is mounted by a side
 * path, so nothing can be mounted unannounced or unchecked.
 *
 * Pure: returns a shallow-copied manifest, never mutates the caller's.
 */
export function injectContextDocuments(
  manifest: AgentManifest,
  uris: readonly string[],
): ContextDocumentsInjection {
  // Dedupe by document id — the same document reachable through both entry
  // paths must be streamed (and counted against the caps) exactly once.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const uri of uris) {
    const id = parseDocumentUri(uri);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(documentUri(id));
  }
  if (unique.length === 0) return { manifest, inputPatch: undefined };

  const schema = (manifest.input?.schema ?? {}) as Record<string, unknown>;
  const properties = manifestInputProperties(manifest) ?? {};
  const nextManifest: AgentManifest = {
    ...manifest,
    input: {
      ...manifest.input,
      schema: {
        ...schema,
        type: "object",
        properties: { ...properties, [CONTEXT_DOCUMENTS_FIELD]: contextDocumentsProperty() },
      },
    },
  } as AgentManifest;

  return { manifest: nextManifest, inputPatch: { [CONTEXT_DOCUMENTS_FIELD]: unique } };
}

/**
 * Normalize the caller's `context_documents` argument into `document://` URIs.
 * Rejects anything that is not a `document://` URI with a 400 naming the
 * offending entry — an `upload://`/`https://` value would otherwise be mounted
 * under a contract that only promises durable, ACL-checked documents.
 */
export function normalizeContextDocumentUris(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw invalidRequest(
      "`context_documents` must be an array of document:// URIs",
      "context_documents",
    );
  }
  return value.map((entry) => {
    if (!isDocumentUri(entry)) {
      throw invalidRequest(
        "`context_documents` entries must be document:// URIs (typically taken from a previous " +
          `run's documents result) — got '${String(entry)}'`,
        "context_documents",
      );
    }
    return entry;
  });
}

/**
 * Trigger an inline agent run end-to-end: insert the shadow package and fire
 * the pipeline. The route owns the earlier stages — `runInlinePreflight`
 * (manifest shape, config, readiness) then `parseRequestInput` (file fields
 * resolved through the SAME parser as `POST /agents/:scope/:name/run`:
 * `upload://` / `document://` / inline `data:` URIs are ACL-checked, capped,
 * and streamed into the pre-minted `runId`'s workspace) — so inline and
 * cataloged runs share one input contract.
 *
 * Throws `ApiError` on validation / pipeline failures (same shape the route
 * already emits). Infrastructure errors bubble as-is so the caller's error
 * handler can surface them as 5xx.
 */
export async function triggerInlineRun(params: {
  orgId: string;
  applicationId: string;
  actor: Actor | null;
  /** Pre-minted run id — input documents already live in its workspace namespace. */
  runId: string;
  /** Preflight result the route computed BEFORE streaming any input document. */
  preflight: InlineRunPreflightResult;
  /** Parsed run input (file fields resolved) from `parseRequestInput`. */
  parsed: ParsedInput;
  apiKeyId?: string;
  /** W3C `traceparent` of the spawning request — forwarded to the runtime. */
  traceparent?: string;
}): Promise<{ runId: string; packageId: string }> {
  const { orgId, applicationId, actor, runId, preflight, parsed, apiKeyId, traceparent } = params;
  const {
    manifest,
    prompt,
    effectiveConfig,
    modelIdOverride,
    proxyIdOverride,
    connectionOverrides,
  } = preflight;

  // `parseRequestInput` already collapses an effectively-empty input to
  // `undefined`; map that to NULL so an input-less inline run persists
  // `runs.input` as SQL NULL — the same representation the agent route uses.
  const effectiveInput = parsed.input ?? null;

  // Reject BEFORE any durable side effect (shadow row, pipeline) when the
  // model-authored prompt names document:// URIs that the resolved input does
  // not mount — a recoverable 400 the chat model can act on. The manifest's
  // input schema tells the guard which fields actually mount a document.
  const inputSchema = manifest.input?.schema
    ? asJSONSchemaObject(manifest.input.schema)
    : undefined;
  assertPromptDocumentsCoveredByInput(prompt, effectiveInput, inputSchema);

  // Reject an unknown/malformed explicit `modelId` with a clean 404 before we
  // mint a shadow package — avoids both a leaked shadow row and the downstream
  // uuid-cast crash.
  await assertExplicitModelExists(orgId, modelIdOverride);

  // ----- Insert shadow row (now that we know the manifest is valid). -----
  const createdBy = actor?.type === "user" ? actor.id : null;
  const shadowId = await insertShadowPackage({ orgId, createdBy, manifest, prompt });
  const shadowAgent = buildShadowLoadedPackage(shadowId, manifest, prompt);

  // ----- Fire the pipeline. -----
  try {
    await prepareAndExecuteRun({
      runId,
      agent: shadowAgent,
      orgId,
      actor,
      input: effectiveInput,
      // File metadata for prompt context — the document bytes were already
      // streamed into the run workspace by `parseRequestInput`.
      files: parsed.uploadedFiles,
      // Staged uploads to materialize into durable `documents` rows after the
      // run row exists (input already rewritten to `document://` ids).
      pendingDocuments: parsed.pendingDocuments,
      // `document://` inputs to protect via `document_links` (chaining).
      consumedDocumentIds: parsed.consumedDocumentIds,
      config: effectiveConfig,
      modelId: modelIdOverride,
      proxyId: proxyIdOverride,
      applicationId,
      apiKeyId,
      connectionOverrides,
      traceparent,
    });
  } catch (err) {
    await deleteOrphanShadowPackage(shadowId);
    throw err;
  }

  return { runId, packageId: shadowId };
}

/**
 * Purge-on-failure. Called when the pipeline rejects BEFORE creating the
 * `runs` row — the shadow row would otherwise leak forever.
 *
 * Defensive guard: `runs.package_id` has `ON DELETE CASCADE`, so deleting
 * a shadow once any `runs` row references it would cascade-wipe the run
 * history. The pipeline contract is "return !ok without creating a runs
 * row", but we cannot rely on that invariant alone — any future refactor
 * could introduce a late failure path that inserts `runs` first and then
 * returns `!ok`. The pre-check below is a belt-and-suspenders: if a
 * `runs` row already points at this shadow, skip the delete entirely and
 * emit an error-level log so operators see the leak instead of losing
 * the history silently.
 *
 * After the pipeline has promoted the shadow into a tracked run, the
 * compaction worker (manifest/prompt NULL-out, row preserved) is the
 * only legitimate cleanup path.
 */
export async function deleteOrphanShadowPackage(id: string): Promise<void> {
  try {
    // Belt: refuse to delete if any run already references the shadow.
    // Cheap single-row probe — `runs.package_id` is indexed.
    const referencing = await db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.packageId, id))
      .limit(1);
    if (referencing.length > 0) {
      logger.error(
        "Refusing to delete inline shadow package with existing run references — pipeline invariant violated",
        { shadowId: id, referencingRunId: referencing[0]!.id },
      );
      return;
    }

    // Suspenders: scope the DELETE to ephemeral-only so any future
    // accidental call with a non-shadow id is a no-op instead of a wipe.
    await db.delete(packages).where(and(eq(packages.id, id), eq(packages.ephemeral, true)));
  } catch (err) {
    // Best-effort cleanup — log and move on. A leaked shadow is reclaimed
    // by the retention worker; a propagated error here would mask the
    // original pipeline failure the caller is already re-throwing.
    logger.warn("Failed to delete orphan shadow package", {
      id,
      error: getErrorMessage(err),
    });
  }
}
