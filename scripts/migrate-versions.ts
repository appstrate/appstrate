/**
 * Backfill migration script: converts legacy integer versionNumber to semver.
 *
 * Run between migration 0011 (additive) and 0012 (cleanup):
 *   bun run scripts/migrate-versions.ts
 *
 * Idempotent: skips rows where `version` is already set.
 */

import postgres from "postgres";
import { computeIntegrity } from "@appstrate/core/integrity";
import { extractDependencies } from "@appstrate/core/dependencies";
import { createLogger } from "@appstrate/core/logger";
import { downloadFile, uploadFile, ensureBucket } from "@appstrate/db/storage";

const log = createLogger("info");

const DATABASE_URL = Bun.env.DATABASE_URL;
if (!DATABASE_URL) {
  log.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 5 });
const BUCKET = "flow-packages";
const BATCH_SIZE = 100;

interface VersionRow {
  id: number;
  package_id: string;
  version_number: number;
  created_at: Date;
}

interface PackageRow {
  id: string;
  org_id: string;
  manifest: Record<string, unknown> | null;
}

async function main() {
  log.info("=== Backfill migration: integer versions → semver ===");

  // 0. Ensure storage bucket exists
  await ensureBucket(BUCKET);

  // 1. Clean orphan versions (package_id not in packages)
  const orphanResult = await sql`
    DELETE FROM package_versions
    WHERE package_id NOT IN (SELECT id FROM packages)
  `;
  log.info("Step 1: Deleted orphan version rows", { count: orphanResult.count });

  // 2. Backfill package_versions rows in batches
  let totalBackfilled = 0;
  let offset = 0;

  while (true) {
    const rows = await sql<VersionRow[]>`
      SELECT id, package_id, version_number, created_at
      FROM package_versions
      WHERE version IS NULL
      ORDER BY id
      LIMIT ${BATCH_SIZE}
      OFFSET ${offset}
    `;

    if (rows.length === 0) break;

    // Pre-fetch package info for this batch
    const packageIds = Array.from(new Set(rows.map((r) => r.package_id)));
    const pkgRows = await sql<PackageRow[]>`
      SELECT id, org_id, manifest FROM packages WHERE id = ANY(${packageIds})
    `;
    const pkgMap = new Map(pkgRows.map((p) => [p.id, p]));

    for (const row of rows) {
      const pkg = pkgMap.get(row.package_id);
      if (!pkg) {
        log.warn("Package not found for version, skipping", { packageId: row.package_id, versionId: row.id });
        continue;
      }

      const semver = `0.0.${row.version_number}`;

      // Try to read existing ZIP from storage
      const oldPath = `${row.package_id}/${row.version_number}.zip`;
      let zipData: Uint8Array | null = null;
      try {
        zipData = await downloadFile(BUCKET, oldPath);
      } catch {
        // File may not exist
      }

      let integrity: string;
      let artifactSize: number;

      if (zipData) {
        integrity = computeIntegrity(zipData);
        artifactSize = zipData.byteLength;

        // Copy to new semver path
        const newPath = `${row.package_id}/${semver}.zip`;
        try {
          await uploadFile(BUCKET, newPath, Buffer.from(zipData));
        } catch (err) {
          log.warn("Failed to copy artifact", { oldPath, newPath, error: err instanceof Error ? err.message : String(err) });
        }
      } else {
        // No artifact on disk — use placeholder integrity
        integrity = "sha256-backfill-no-artifact";
        artifactSize = 0;
        log.warn("No artifact found", { packageId: row.package_id, versionNumber: row.version_number });
      }

      const manifest = pkg.manifest ?? {};

      await sql`
        UPDATE package_versions
        SET
          version = ${semver},
          integrity = ${integrity},
          artifact_size = ${artifactSize},
          manifest = ${JSON.stringify(manifest)}::jsonb,
          org_id = ${pkg.org_id}::uuid
        WHERE id = ${row.id} AND version IS NULL
      `;

      totalBackfilled++;
    }

    log.info("Backfilled batch", { batch: rows.length, total: totalBackfilled });

    // If we got fewer than BATCH_SIZE, we're done
    if (rows.length < BATCH_SIZE) break;
    // Don't increment offset since we're filtering WHERE version IS NULL
    // and updating rows removes them from the result set
  }

  log.info("Step 2: Backfilled version rows", { count: totalBackfilled });

  // 3. Create dist-tag "latest" for each package
  const packagesWithVersions = await sql<{ package_id: string; max_id: number }[]>`
    SELECT package_id, MAX(id) as max_id
    FROM package_versions
    WHERE version IS NOT NULL
    GROUP BY package_id
  `;

  let distTagCount = 0;
  for (const { package_id, max_id } of packagesWithVersions) {
    await sql`
      INSERT INTO package_dist_tags (package_id, tag, version_id, updated_at)
      VALUES (${package_id}, 'latest', ${max_id}, NOW())
      ON CONFLICT (package_id, tag) DO NOTHING
    `;
    distTagCount++;
  }

  log.info("Step 3: Created latest dist-tags", { count: distTagCount });

  // 4. Backfill packageVersionDependencies from manifests
  const versionsWithManifest = await sql<{ id: number; manifest: Record<string, unknown> }[]>`
    SELECT pv.id, pv.manifest
    FROM package_versions pv
    LEFT JOIN package_version_dependencies pvd ON pvd.version_id = pv.id
    WHERE pv.manifest IS NOT NULL
    GROUP BY pv.id, pv.manifest
    HAVING COUNT(pvd.id) = 0
  `;

  let depCount = 0;
  for (const ver of versionsWithManifest) {
    const deps = extractDependencies(ver.manifest);
    if (deps.length === 0) continue;

    for (const dep of deps) {
      await sql`
        INSERT INTO package_version_dependencies (version_id, dep_scope, dep_name, dep_type, version_range)
        VALUES (${ver.id}, ${dep.depScope}, ${dep.depName}, ${dep.depType}::package_type, ${dep.versionRange})
        ON CONFLICT (version_id, dep_scope, dep_name, dep_type) DO NOTHING
      `;
      depCount++;
    }
  }

  log.info("Step 4: Created version dependency rows", { count: depCount });

  // Summary
  log.info("Migration complete", {
    orphansCleaned: orphanResult.count,
    versionsBackfilled: totalBackfilled,
    distTagsCreated: distTagCount,
    versionDepsCreated: depCount,
  });

  await sql.end();
}

main().catch((err) => {
  log.error("Migration failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
