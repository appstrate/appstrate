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
import { ApiError } from "../lib/errors.ts";
import { logger } from "../lib/logger.ts";
import { runInlinePreflight, type InlineRunBody } from "./inline-run-preflight.ts";
import { prepareAndExecuteRun } from "./run-pipeline.ts";

export type { InlineRunBody };

/** Reserved scope for inline-run shadow packages. Never publishable. */
export const INLINE_SHADOW_SCOPE = "inline";

/**
 * Return true when the package id belongs to the reserved inline scope.
 * Cheap string test — no DB. Use this to decorate run events (e.g. webhook
 * `packageEphemeral`) without a `packages` lookup.
 */
export function isInlineShadowPackageId(packageId: string): boolean {
  return packageId.startsWith(`@${INLINE_SHADOW_SCOPE}/`);
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
 * Build a `LoadedPackage` from an already-inserted shadow row. Inline
 * manifests only embed ID refs, so callers must pass the resolved
 * skills/tools (via `resolveManifestCatalogDeps`) when the returned
 * package will flow into the run pipeline — otherwise `env-builder`
 * will see empty arrays and skip skill/tool injection into the
 * container. Defaults to empty arrays for callers that only need the
 * shape (e.g. deserialization, tests).
 */
export function buildShadowLoadedPackage(
  id: string,
  manifest: AgentManifest,
  prompt: string,
  deps: Pick<LoadedPackage, "skills" | "tools"> = { skills: [], tools: [] },
): LoadedPackage {
  return {
    id,
    manifest,
    prompt,
    skills: deps.skills,
    tools: deps.tools,
    source: "local",
  };
}

/**
 * Trigger an inline agent run end-to-end.
 *
 * Mirrors the route-handler body of `POST /api/runs/inline`: preflight ->
 * insert shadow package -> fire pipeline -> return `{ runId, packageId }`.
 * Both the HTTP route and `PlatformServices.inline.run` call this single
 * implementation so the contract stays in lockstep across surfaces.
 *
 * Throws `ApiError` on validation / pipeline failures (same shape the route
 * already emits). Infrastructure errors bubble as-is so the caller's error
 * handler can surface them as 5xx.
 */
export async function triggerInlineRun(params: {
  orgId: string;
  applicationId: string;
  actor: Actor | null;
  body: InlineRunBody;
  apiKeyId?: string;
}): Promise<{ runId: string; packageId: string }> {
  const { orgId, applicationId, actor, body, apiKeyId } = params;

  // ----- 1. Preflight — shape + providers + readiness (no side effects). -----
  const preflight = await runInlinePreflight({ orgId, applicationId, actor, body });
  const {
    manifest,
    prompt,
    effectiveConfig,
    effectiveInput,
    providerProfiles,
    modelIdOverride,
    proxyIdOverride,
    resolvedDeps,
  } = preflight;

  // ----- 2. Insert shadow row (now that we know the manifest is valid). -----
  const createdBy = actor?.type === "member" ? actor.id : null;
  const shadowId = await insertShadowPackage({ orgId, createdBy, manifest, prompt });
  const shadowAgent = buildShadowLoadedPackage(shadowId, manifest, prompt, resolvedDeps);

  // ----- 3. Fire the pipeline. -----
  const runId = `run_${crypto.randomUUID()}`;
  let pipelineResult;
  try {
    pipelineResult = await prepareAndExecuteRun({
      runId,
      agent: shadowAgent,
      providerProfiles,
      orgId,
      actor,
      input: effectiveInput,
      config: effectiveConfig,
      modelId: modelIdOverride,
      proxyId: proxyIdOverride,
      applicationId,
      apiKeyId,
    });
  } catch (err) {
    await deleteOrphanShadowPackage(shadowId);
    throw err;
  }

  if (!pipelineResult.ok) {
    await deleteOrphanShadowPackage(shadowId);
    const { error } = pipelineResult;
    if (error.code === "model_not_configured") {
      throw new ApiError({
        status: 400,
        code: "model_not_configured",
        title: "Bad Request",
        detail: error.message,
      });
    }
    if ("status" in error && typeof error.status === "number") {
      throw new ApiError({
        status: error.status,
        code: error.code,
        title: error.message,
        detail: error.message,
      });
    }
    throw new ApiError({
      status: 500,
      code: "inline_run_failed",
      title: "Inline run failed",
      detail: error.message,
    });
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
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
