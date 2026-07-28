// SPDX-License-Identifier: Apache-2.0

/**
 * Fills an EMPTY instance with real agents and their hand-written logic maps, so
 * the logic-map renderer can be exercised before the cartographer agent exists.
 *
 * Self-contained on purpose: it applies the core migrations, creates an account
 * and an organisation, imports the agent definitions, publishes a version for
 * each, then attaches the map written for it. Point it at a fresh worktree and
 * you get a working instance in one command — no database to copy from another
 * checkout, no server to start first.
 *
 *   bun run --cwd apps/api seed:logic-maps
 *   AGENTS_DIR=/path/to/agents bun run --cwd apps/api seed:logic-maps
 *
 * The server must NOT be running: the embedded database is a single file and
 * only one process may hold it. Start the server after seeding.
 *
 * Idempotent: an existing account, organisation, agent or map is reused or
 * replaced rather than duplicated.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  applications,
  organizationMembers,
  organizations,
  packageDistTags,
  packageLogicMaps,
  packageVersions,
  packages,
  profiles,
  user as userTable,
} from "@appstrate/db/schema";
import { computeIntegrity } from "@appstrate/core/integrity";

const MAPS_DIR = resolve(import.meta.dir, "../../../examples/logic-map");
/** Where the agent definitions live. Outside the repo by default — they are Tractr's, not the platform's. */
const AGENTS_DIR = resolve(
  process.env["AGENTS_DIR"] ?? join(import.meta.dir, "../../../../../satellites/implantation"),
);
const EMAIL = process.env["SEED_EMAIL"] ?? "demo@appstrate.local";
const ORG_SLUG = process.env["SEED_ORG_SLUG"] ?? "demo";

// ─── 1. Schema ──────────────────────────────────────────────────────────────
// Normally applied at boot. Doing it here is what lets this script run against a
// worktree whose database has never been opened.
const { applyCorePGliteMigrations } = await import("../src/lib/pglite-migrate.ts");
await applyCorePGliteMigrations(resolve(import.meta.dir, "../../../packages/db/drizzle"));
console.log("migrations applied");

// ─── 2. Account and organisation ────────────────────────────────────────────
let [account] = await db.select().from(userTable).where(eq(userTable.email, EMAIL)).limit(1);
if (!account) {
  const id = crypto.randomUUID();
  [account] = await db
    .insert(userTable)
    .values({ id, name: "Demo", email: EMAIL, emailVerified: true, realm: "platform" })
    .returning();
  await db.insert(profiles).values({ id, displayName: "Demo", language: "fr" });
  console.log(`account created: ${EMAIL}`);
  console.log("  (no password — sign in through the onboarding flow, or set one from the UI)");
}

let [org] = await db.select().from(organizations).where(eq(organizations.slug, ORG_SLUG)).limit(1);
if (!org) {
  [org] = await db
    .insert(organizations)
    .values({ name: "Demo", slug: ORG_SLUG, createdBy: account!.id })
    .returning();
  await db
    .insert(organizationMembers)
    .values({ orgId: org!.id, userId: account!.id, role: "owner" });
  console.log(`organisation created: ${ORG_SLUG}`);
}

let [app] = await db.select().from(applications).where(eq(applications.orgId, org!.id)).limit(1);
if (!app) {
  [app] = await db
    .insert(applications)
    .values({
      id: `app_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      orgId: org!.id,
      name: "Default",
      isDefault: true,
    })
    .returning();
  console.log("default application created");
}

// ─── 3. Agents, versions, maps ──────────────────────────────────────────────
/** Map file → the agent directory it describes, matched on the map's own package id. */
const mapFiles = readdirSync(MAPS_DIR).filter((f) => f.endsWith(".logic-map.json"));
let seeded = 0;
const skipped: string[] = [];

for (const file of mapFiles) {
  const map = JSON.parse(readFileSync(join(MAPS_DIR, file), "utf8")) as {
    source: { package_id: string };
    generator?: { kind?: string; version?: string | null };
    overall_confidence?: number;
  };
  const shortName = map.source.package_id.split("/").pop()!;

  // Fleet and public agents have no definition here — that is a skip, not a failure.
  const dirs = ["tractr/agents", "core/agents", "perso/agents"]
    .map((d) => join(AGENTS_DIR, d, shortName))
    .filter((d) => existsSync(join(d, "manifest.json")));
  const dir = dirs[0];
  if (!dir) {
    skipped.push(`${file} — no definition under ${AGENTS_DIR}`);
    continue;
  }

  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    name: string;
    version?: string;
  };
  const prompt = existsSync(join(dir, "prompt.md"))
    ? readFileSync(join(dir, "prompt.md"), "utf8")
    : "";
  // The package id is the org's own scope, not whatever the definition ships with:
  // an agent imported into an organisation belongs to it.
  const packageId = `@${ORG_SLUG}/${shortName}`;

  await db
    .insert(packages)
    .values({
      // `@scope/name` EST la clé : la table ne porte ni colonne scope ni colonne name.
      id: packageId,
      orgId: org!.id,
      type: "agent" as const,
      source: "local",
      draftManifest: { ...manifest, name: packageId },
      draftContent: prompt,
      createdBy: account!.id,
    })
    .onConflictDoNothing();

  const version = manifest.version ?? "1.0.0";
  const integrity = await computeIntegrity(new TextEncoder().encode(prompt));
  let [row] = await db
    .select()
    .from(packageVersions)
    .where(eq(packageVersions.packageId, packageId))
    .limit(1);
  if (!row) {
    [row] = await db
      .insert(packageVersions)
      .values({
        packageId,
        version,
        integrity,
        artifactSize: prompt.length,
        manifest: { ...manifest, name: packageId },
        createdBy: account!.id,
      })
      .returning();
    await db
      .insert(packageDistTags)
      .values({ packageId, tag: "latest", versionId: row!.id })
      .onConflictDoNothing();
  }

  await db.delete(packageLogicMaps).where(eq(packageLogicMaps.versionId, row!.id));
  await db.insert(packageLogicMaps).values({
    versionId: row!.id,
    packageId,
    orgId: org!.id,
    // The hand-written maps predate any published bundle, so they take the
    // version's integrity — seeding must not show up as stale.
    integrity: row!.integrity,
    map,
    generatorKind: map.generator?.kind ?? "human",
    generatorVersion: map.generator?.version ?? null,
    overallConfidence: map.overall_confidence ?? null,
  });

  console.log(`  ${packageId} — map attached (${version})`);
  seeded++;
}

console.log(`\n${seeded} agent(s) seeded with their logic map, ${skipped.length} skipped.`);
for (const reason of skipped) console.log(`  - ${reason}`);
console.log(`\nStart the server, sign in as ${EMAIL}, open an agent → Map → Logic.`);
process.exit(0);
