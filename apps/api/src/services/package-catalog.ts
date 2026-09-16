// SPDX-License-Identifier: Apache-2.0

import { eq, and, count, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, packageShares } from "@appstrate/db/schema";
import type { PackageType } from "@appstrate/core/validation";
import { caretRange } from "@appstrate/core/semver";
import type { AgentManifest, LoadedPackage } from "../types/index.ts";
import { asRecord } from "@appstrate/core/safe-json";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import { extractSkillIdsFromManifest, parseDraftManifest } from "../lib/manifest-utils.ts";
import { isPackageReadableInSpace } from "../lib/package-access.ts";
import { placementReadFilter, placementShareJoin } from "./package-placement.ts";

interface DbPackageRow {
  id: string;
  draftManifest: unknown;
  draftContent: string;
  source?: string;
  updatedAt?: Date;
}

/**
 * One entry of a manifest's `dependencies.skills` map, paired with what the
 * org/system catalog knows about it.
 *
 * Every DECLARED skill gets an entry — `resolved: false` marks one the
 * declaring package cannot reach. Callers that filter (readiness, run
 * paths) and callers that display (detail DTOs, missing ones included) read
 * the same array; absence is a flag, never a shorter list (#878).
 */
interface DeclaredSkill {
  id: string;
  /** Range declared by the manifest, or caret-of-current when it carries none. */
  version: string;
  /** True when a skill package with this id is PLACED where the declaring package lives. */
  resolved: boolean;
  name?: string;
  description?: string;
}

/**
 * WHERE a declared dependency is judged from — the declaring package's own
 * HOME, or the current space when it has none.
 *
 * The home is the right anchor because a closure belongs to the package that
 * declares it, not to the space a run happens to start in: an agent homed in
 * team space T and OFFERED to space U must keep running U's launches with the
 * skills T placed beside it.
 *
 * The fallback covers the two rows that carry no home: a SYSTEM agent, whose
 * skills pass `placementReadFilter` on `source` alone, and an inline run's
 * `ephemeral` shadow, whose references
 * `assertPackageDependenciesAccessible` has already judged against the
 * caller's own reach.
 *
 * `declaringPackageId` is the CATALOGUE row's id — never `manifest.name`,
 * which an inline run's caller writes freely and could therefore point at
 * somebody else's agent to borrow its home.
 */
async function placementAnchor(
  declaringPackageId: string,
  orgId: string,
  spaceId: string,
): Promise<string> {
  const [row] = await db
    .select({ homeSpaceId: packages.homeSpaceId })
    .from(packages)
    .where(and(eq(packages.id, declaringPackageId), orgOrSystemFilter(orgId)))
    .limit(1);
  return row?.homeSpaceId ?? spaceId;
}

function dbRowToLoadedPackage(row: DbPackageRow): LoadedPackage {
  return {
    id: row.id,
    manifest: asRecord(row.draftManifest) as AgentManifest,
    prompt: row.draftContent,
    source: (row.source as "system" | "local") ?? "local",
    updatedAt: row.updatedAt,
  };
}

/**
 * Project a manifest's declared skill dependencies against the catalogue, as
 * the DECLARING package may reach it. The manifest handed in is the single
 * input for what is declared — the projection is recomputed per call and never
 * cached on a package object, so it cannot go stale when a caller swaps the
 * draft manifest for a published snapshot (#878). Returns one entry per
 * declared skill, in manifest order.
 *
 * PLACEMENT is part of the question, not a gate applied afterwards (RBAC spec
 * §6.9): `placementReadFilter` is conjoined here. Resolving on `org_id` alone
 * would make this the one reader answering for a package no route will show — a
 * skill homed in somebody's PERSONAL space — and the answer is not inert:
 * `RunPackageCatalog` carries no placement predicate of its own, so that skill's
 * bytes would be assembled into the run's bundle, and its `display_name` and
 * `description` handed to the detail page live off its draft manifest.
 *
 * An unreachable skill is therefore reported exactly as a missing one —
 * `resolved: false`, no `name`, no `description`. Telling the two apart would
 * be an existence oracle over every package the organization owns.
 *
 * No DB read happens when the manifest declares no skills.
 */
export async function resolveDeclaredSkills(
  manifest: AgentManifest,
  orgId: string,
  /** The catalogue row declaring them, and the space to fall back on — see {@link placementAnchor}. */
  declaredBy: { packageId: string; spaceId: string },
): Promise<DeclaredSkill[]> {
  const m = parseDraftManifest(manifest);
  const declaredRanges = asRecord(asRecord(m.dependencies).skills) as Record<string, string>;
  const skillIds = extractSkillIdsFromManifest(m);
  if (skillIds.length === 0) return [];

  const anchor = await placementAnchor(declaredBy.packageId, orgId, declaredBy.spaceId);
  const rows = await db
    .select({
      id: packages.id,
      type: packages.type,
      draftManifest: packages.draftManifest,
    })
    .from(packages)
    // The share half of `placementReadFilter` is read off this join; without
    // it every offered skill would resolve as unreachable.
    .leftJoin(packageShares, placementShareJoin(packages.id, anchor))
    .where(
      and(inArray(packages.id, skillIds), orgOrSystemFilter(orgId), placementReadFilter(anchor)),
    );

  // A row of the wrong type is not a skill dependency, resolved or otherwise.
  const bySkillId = new Map(rows.filter((r) => r.type === "skill").map((r) => [r.id, r]));

  return skillIds.map((id) => {
    const row = bySkillId.get(id);
    if (!row) return { id, version: declaredRanges[id] ?? "*", resolved: false };

    const depManifest = parseDraftManifest(row.draftManifest);
    return {
      id,
      // The manifest's declared range is the source of truth. When a resolved
      // dep carries none (data inconsistency — `extractSkillIdsFromManifest`
      // reads the same section), fall back to caret-of-current rather than
      // emitting a bare wildcard. `version` is "0.0.0" only for a malformed
      // draft, which would not load at runtime anyway.
      version: declaredRanges[id] ?? caretRange(depManifest.version ?? "0.0.0"),
      resolved: true,
      name: depManifest.display_name ?? undefined,
      description: depManifest.description ?? undefined,
    };
  });
}

/**
 * Get a single package by ID. Filters orgId (includes system packages via
 * orgId: null) AND excludes ephemeral shadow packages by default.
 *
 * Set `opts.includeEphemeral` to load an inline-run shadow row directly
 * (used only by the compaction worker and test fixtures — never by
 * user-facing paths).
 */
export async function getPackage(
  id: string,
  orgId: string,
  opts: { includeEphemeral?: boolean } = {},
): Promise<LoadedPackage | null> {
  const conditions = [eq(packages.id, id), orgOrSystemFilter(orgId)];
  if (!opts.includeEphemeral) conditions.push(notEphemeralFilter());

  const pkgRows = await db
    .select({
      id: packages.id,
      draftManifest: packages.draftManifest,
      draftContent: packages.draftContent,
      source: packages.source,
      updatedAt: packages.updatedAt,
    })
    .from(packages)
    .where(and(...conditions))
    .limit(1);

  const pkgRow = pkgRows[0];
  if (!pkgRow) return null;

  // Deliberately does NOT resolve the skill closure. That projection depends on
  // the manifest, and a `LoadedPackage` whose manifest can later be swapped for
  // a published snapshot must not carry a projection of the draft's (#878).
  // Callers that need it derive it explicitly via `resolveDeclaredSkills`.
  return dbRowToLoadedPackage({
    id: pkgRow.id,
    draftManifest: pkgRow.draftManifest,
    draftContent: pkgRow.draftContent ?? "",
    source: pkgRow.source,
    updatedAt: pkgRow.updatedAt,
  });
}

/**
 * Load an agent for a READ, not for a run: the agent's HOME grants it too, so
 * an author keeps sight of an agent placed only in spaces they cannot reach
 * (RBAC spec §6.9). Returns null when the agent is not found or not readable
 * here — 404 semantics, no info leak.
 *
 * The RUN-side gate is `requireAgent()` (`middleware/guards.ts`), which asks
 * `isPackageActiveHere` and then tells "placed but switched off" from "not placed
 * here" so the two refusals can be acted on differently. It does not live here
 * because that distinction needs the reachability read as well, and folding
 * both into one loader is what made every launch door answer the same opaque
 * code.
 */
export async function getPackageForRead(
  id: string,
  orgId: string,
  spaceId: string,
): Promise<LoadedPackage | null> {
  const agent = await getPackage(id, orgId);
  if (!agent) return null;

  if (!(await isPackageReadableInSpace(spaceId, id))) return null;

  return agent;
}

/** Get all package IDs (system + user, scoped by org). Used for collision checks. */
export async function getAllPackageIds(orgId?: string, type?: string): Promise<string[]> {
  const conditions = [notEphemeralFilter()];
  if (orgId) {
    conditions.push(orgOrSystemFilter(orgId));
  }
  if (type) {
    conditions.push(eq(packages.type, type as PackageType));
  }
  const rows = await db
    .select({ id: packages.id })
    .from(packages)
    .where(and(...conditions));

  return rows.map((r) => r.id);
}

/**
 * Check if a package exists (system or user). Ignores ephemeral shadow
 * packages — callers (scheduler, imports) never legitimately target one.
 */
export async function packageExists(id: string): Promise<boolean> {
  const rows = await db
    .select({ cnt: count() })
    .from(packages)
    .where(and(eq(packages.id, id), notEphemeralFilter()));
  return (rows[0]?.cnt ?? 0) > 0;
}
