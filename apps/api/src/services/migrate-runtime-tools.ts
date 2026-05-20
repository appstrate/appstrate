// SPDX-License-Identifier: Apache-2.0

/**
 * Boot-time migration — agent `dependencies.tools` → `runtimeTools`.
 *
 * The `tool` AFPS package type was removed: the former system tools
 * (output/log/note/pin/report) are now built-in runtime tools selected
 * per agent via the top-level `runtimeTools: string[]` manifest field
 * (`output` is always injected and never listed). This migration rewrites
 * any persisted agent manifest (and draft manifest) that still carries the
 * legacy `dependencies.tools` map:
 *
 *   - `@appstrate/output`            → dropped (now mandatory/auto-injected)
 *   - `@appstrate/{log,note,pin,report}` → added to `runtimeTools`
 *   - any other tool id              → FAIL LOUD (unknown third-party tool;
 *                                       requires manual intervention)
 *
 * The pure per-manifest transform lives in {@link ./migrate-runtime-tools-core.ts}
 * (DB-free, unit-tested in isolation). This module owns the DB walk.
 *
 * Idempotent: rows without `dependencies.tools` are skipped, so re-running
 * is a no-op.
 */

import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, packageVersions } from "@appstrate/db/schema";
import { migrateManifest } from "./migrate-runtime-tools-core.ts";
import { logger } from "../lib/logger.ts";

export { migrateManifest } from "./migrate-runtime-tools-core.ts";
export type { MigratedManifest } from "./migrate-runtime-tools-core.ts";

/**
 * Run the migration over every agent package. Throws (fail loud) if any
 * agent references an unknown tool id, so the operator resolves it
 * explicitly rather than silently losing a capability.
 */
export async function migrateAgentRuntimeTools(): Promise<void> {
  const unknown = new Set<string>();
  let migrated = 0;

  // ── Draft manifests live on `packages.draft_manifest`. ──────────────
  const draftRows = await db
    .select({
      id: packages.id,
      draftManifest: packages.draftManifest,
    })
    .from(packages)
    .where(and(eq(packages.type, "agent"), isNotNull(packages.draftManifest)));

  for (const row of draftRows) {
    const d = migrateManifest(row.draftManifest, unknown);
    if (!d.changed) continue;
    await db.update(packages).set({ draftManifest: d.manifest }).where(eq(packages.id, row.id));
    migrated += 1;
  }

  // ── Published manifests live on `package_versions.manifest`, one row ──
  //    per version. Join to `packages` to scope to agent packages only.
  const versionRows = await db
    .select({
      id: packageVersions.id,
      manifest: packageVersions.manifest,
    })
    .from(packageVersions)
    .innerJoin(packages, eq(packageVersions.packageId, packages.id))
    .where(eq(packages.type, "agent"));

  for (const row of versionRows) {
    const m = migrateManifest(row.manifest, unknown);
    if (!m.changed) continue;
    await db
      .update(packageVersions)
      .set({ manifest: m.manifest })
      .where(eq(packageVersions.id, row.id));
    migrated += 1;
  }

  if (unknown.size > 0) {
    throw new Error(
      `Cannot migrate agent tools to runtimeTools: unknown tool dependencies referenced ` +
        `(the 'tool' package type was removed). Resolve manually: ${[...unknown].join(", ")}`,
    );
  }

  if (migrated > 0) {
    logger.info("Migrated agent dependencies.tools → runtimeTools", { manifests: migrated });
  }
}
