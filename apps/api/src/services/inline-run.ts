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
import type { ParsedInput } from "./input-parser.ts";
import { prepareAndExecuteRun } from "./run-pipeline.ts";
import { assertExplicitModelExists } from "./org-models.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import {
  documentUri,
  extractDocumentIds,
  extractDocumentIdsFromText,
} from "@appstrate/core/document-uri";
import { validationFailed } from "../lib/errors.ts";

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
 * AND the `document://` URI is passed through the top-level `input` — the
 * platform then streams the file into the workspace under `documents/`. A
 * `document://` URI merely pasted into the sub-agent's prompt text is inert: the
 * runtime has no way to fetch it, so the run launches against dead URIs and the
 * sub-agent silently sees nothing. The chat model has been observed doing
 * exactly this. Fail loudly with a recoverable 400 that names the offending URIs
 * and the exact fix, so the chat model self-corrects (its prompt already retries
 * recoverable field-validation errors) instead of shipping silent garbage.
 *
 * `document://` only, by design: this runs AFTER `parseRequestInput`, which has
 * already rewritten any `upload://` input to a fresh `document://` id the model
 * never saw — so a symmetric `upload://` prompt-vs-input comparison would
 * false-positive on a correctly-declared upload field. There is also no
 * core-level canonical `upload://` text-scanner to reuse (the upload parser
 * lives in the apps/api uploads service), and the observed live failure is
 * `document://` URIs. Pure — exported for unit tests.
 */
export function assertPromptDocumentsCoveredByInput(prompt: string, input: unknown): void {
  const promptIds = extractDocumentIdsFromText(prompt);
  if (promptIds.length === 0) return;
  const covered = new Set(extractDocumentIds(input));
  const uncovered = promptIds.filter((id) => !covered.has(id));
  if (uncovered.length === 0) return;
  throw validationFailed([
    {
      field: "prompt",
      code: "document_uri_in_prompt",
      title: "Document URI In Prompt",
      message:
        "The run prompt references document:// URIs but the run cannot read documents from " +
        "prompt text. Declare a file input field in manifest.input.schema " +
        '({"type":"string","format":"uri","contentMediaType":"<mime>"}) and pass each ' +
        "document:// URI in the top-level input. Unreferenced: " +
        uncovered.map(documentUri).join(", "),
    },
  ]);
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
  const { manifest, prompt, effectiveConfig, modelIdOverride, proxyIdOverride } = preflight;

  // `parseRequestInput` already collapses an effectively-empty input to
  // `undefined`; map that to NULL so an input-less inline run persists
  // `runs.input` as SQL NULL — the same representation the agent route uses.
  const effectiveInput = parsed.input ?? null;

  // Reject BEFORE any durable side effect (shadow row, pipeline) when the
  // model-authored prompt names document:// URIs that the resolved input does
  // not mount — a recoverable 400 the chat model can act on.
  assertPromptDocumentsCoveredByInput(prompt, effectiveInput);

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
      config: effectiveConfig,
      modelId: modelIdOverride,
      proxyId: proxyIdOverride,
      applicationId,
      apiKeyId,
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
