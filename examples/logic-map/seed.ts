// SPDX-License-Identifier: Apache-2.0

/**
 * Loads the hand-written logic maps of this directory into `package_logic_maps`,
 * so the renderer can be exercised before the cartographer agent exists.
 *
 * These maps were written by hand against real prompts (Tractr agents, LangSmith
 * Fleet agents, public coding agents), which is exactly what makes them worth
 * seeding: they are what a good cartographer output looks like.
 *
 *   bun examples/logic-map/seed.ts                    # every map whose agent is installed
 *   bun examples/logic-map/seed.ts compta-gmail-harvest
 *
 * Idempotent: an existing row for the same version is replaced.
 *
 * Matching is by agent NAME, not by file name — a map file is named after the
 * agent it describes, and only the agents actually published in this instance
 * get a row. Anything else is reported and skipped rather than silently dropped.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packageLogicMaps, packageVersions, packages } from "@appstrate/db/schema";

const DIR = join(import.meta.dir);
const only = process.argv[2];

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".logic-map.json"))
  .filter((f) => !only || f.startsWith(only));

if (files.length === 0) {
  console.error(`No map file matched${only ? ` "${only}"` : ""}.`);
  process.exit(1);
}

let seeded = 0;
const skipped: string[] = [];

for (const file of files) {
  const map = JSON.parse(readFileSync(join(DIR, file), "utf8")) as {
    source: { package_id: string };
    generator?: { kind?: string; version?: string | null };
    overall_confidence?: number;
  };

  // The map's own `package_id` is authoritative — a Fleet or public agent simply
  // has no counterpart here, and that is a skip, not a failure.
  const name = map.source.package_id.split("/").pop()!;
  const [pkg] = await db
    .select({ id: packages.id, orgId: packages.orgId })
    .from(packages)
    .where(eq(packages.name, name))
    .limit(1);

  if (!pkg) {
    skipped.push(`${file} — no installed agent named "${name}"`);
    continue;
  }

  const [version] = await db
    .select({ id: packageVersions.id, integrity: packageVersions.integrity })
    .from(packageVersions)
    .where(eq(packageVersions.packageId, pkg.id))
    .orderBy(packageVersions.id)
    .limit(1);

  if (!version) {
    skipped.push(`${file} — "${name}" has no published version`);
    continue;
  }

  await db.delete(packageLogicMaps).where(eq(packageLogicMaps.versionId, version.id));
  await db.insert(packageLogicMaps).values({
    versionId: version.id,
    packageId: pkg.id,
    orgId: pkg.orgId,
    // The stored map carries no integrity of its own (it predates any published
    // bundle), so it takes the version's — seeding must not look stale.
    integrity: version.integrity,
    map,
    generatorKind: map.generator?.kind ?? "human",
    generatorVersion: map.generator?.version ?? null,
    overallConfidence: map.overall_confidence ?? null,
  });
  seeded++;
  console.log(`  seeded ${name} → version ${version.id}`);
}

console.log(`\n${seeded} map(s) seeded, ${skipped.length} skipped.`);
for (const reason of skipped) console.log(`  - ${reason}`);
process.exit(0);
