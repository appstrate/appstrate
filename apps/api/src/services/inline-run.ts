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

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages } from "@appstrate/db/schema";
import type { AgentManifest, LoadedPackage } from "../types/index.ts";
import { logger } from "../lib/logger.ts";

/** Reserved scope for inline-run shadow packages. Never publishable. */
export const INLINE_SHADOW_SCOPE = "inline";

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
 * validation + pipeline dispatch. Retry on the vanishingly rare UUID
 * collision — at 128 bits, one collision per ~2^64 inserts.
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
 * Build a `LoadedPackage` from an already-inserted shadow row. Skips
 * dependency resolution because inline manifests CANNOT embed transitive
 * dependencies — deps in an inline manifest are **ID references only** and
 * resolved from the org/system catalog at run time via the standard
 * provider/skill/tool resolution path. No additional DB read is needed.
 */
export function buildShadowLoadedPackage(
  id: string,
  manifest: AgentManifest,
  prompt: string,
): LoadedPackage {
  return {
    id,
    manifest,
    prompt,
    skills: [],
    tools: [],
    source: "local",
  };
}

/**
 * Purge-on-failure. Called when preflight/pipeline rejects BEFORE creating
 * the `runs` row — the shadow row would otherwise leak forever. Once a
 * `runs` row exists the FK prevents deletion (cascade would wipe the run),
 * so the compaction job is the only legitimate cleanup path.
 */
export async function deleteOrphanShadowPackage(id: string): Promise<void> {
  try {
    await db.delete(packages).where(eq(packages.id, id));
  } catch (err) {
    // Best-effort cleanup — log and move on.
    logger.warn("Failed to delete orphan shadow package", {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
