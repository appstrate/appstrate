// SPDX-License-Identifier: Apache-2.0

/**
 * Unified persistence service — one store for both agent primitives
 * (`checkpoint` overwrite-latest + `memory` append-list) with scope
 * (user / end_user / shared) as a first-class dimension.
 *
 * See `docs/adr/ADR-011-checkpoint-unification.md` for the design.
 *
 * Storage-layer vocabulary note: the `actor_type` column uses `"user"`
 * (matching the `@afps-spec/schema` wire format), while the in-process
 * `Actor` type (`@appstrate/connect`) uses `"member"` for dashboard users.
 * This module speaks `Actor` at its public boundary and translates at
 * the DB boundary — callers never see `"user"` vs `"member"` divergence.
 */

import { and, asc, count, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packagePersistence } from "@appstrate/db/schema";
import type { Actor } from "../../lib/actor.ts";

// Per-entry char cap and per-scope row cap.
export const MAX_MEMORY_CONTENT = 2000;
export const MAX_MEMORIES_PER_SCOPE = 100;

/**
 * Persistence scope. Narrower than `Actor` by one case: a storage scope may
 * be explicitly `"shared"` (app-wide), which an incoming run may or may not
 * map to — scheduled/system runs land on `shared` automatically, while a
 * dashboard-user run with `scope: "shared"` explicitly is the runtime
 * opting into app-wide behaviour.
 */
export type PersistenceScope =
  | { type: "member"; id: string }
  | { type: "end_user"; id: string }
  | { type: "shared" };

export type PersistenceKind = "checkpoint" | "memory";

export interface Memory {
  id: number;
  content: unknown;
  runId: string | null;
  createdAt: Date;
  actorType: "user" | "end_user" | "shared";
  actorId: string | null;
}

// --- Actor ↔ storage translation --------------------------------------------

/**
 * Resolve the default scope for a run context. End-user impersonation wins
 * over the dashboard user (mirrors `getActor()` in `lib/actor.ts`). When
 * neither is set (scheduler / system runs), we fall through to `shared`.
 */
export function scopeFromRunContext(ctx: {
  userId?: string | null;
  endUserId?: string | null;
}): PersistenceScope {
  if (ctx.endUserId) return { type: "end_user", id: ctx.endUserId };
  if (ctx.userId) return { type: "member", id: ctx.userId };
  return { type: "shared" };
}

/** Produce the storage-shape `{actor_type, actor_id}` from a scope. */
function storageActor(scope: PersistenceScope): {
  actorType: "user" | "end_user" | "shared";
  actorId: string | null;
} {
  if (scope.type === "shared") return { actorType: "shared", actorId: null };
  if (scope.type === "end_user") return { actorType: "end_user", actorId: scope.id };
  return { actorType: "user", actorId: scope.id };
}

/**
 * Build the WHERE clause that narrows a query to a single persistence
 * scope. Encapsulates the `shared` ↔ `(actor_type, actor_id)` translation
 * so every read/write path uses the exact same predicate (a divergence
 * here would silently leak rows across actors).
 *
 * Returns a Drizzle SQL expression suitable for `and(...)` composition.
 */
function buildScopeFilter(scope: PersistenceScope) {
  const { actorType, actorId } = storageActor(scope);
  return actorType === "shared"
    ? and(eq(packagePersistence.actorType, "shared"), isNull(packagePersistence.actorId))
    : and(eq(packagePersistence.actorType, actorType), eq(packagePersistence.actorId, actorId!));
}

/**
 * Narrow an `Actor` (platform convention) into a `PersistenceScope`. Passing
 * `null` is the "scheduled / system run" path — maps to `shared`. This is the
 * adapter every caller should use: `Actor` flows through the app; scope stays
 * internal to the storage layer.
 */
export function scopeFromActor(actor: Actor | null): PersistenceScope {
  if (!actor) return { type: "shared" };
  return actor;
}

// --- Checkpoint -------------------------------------------------------------

/**
 * Read the checkpoint for a given scope, with `shared` fallback.
 *
 * The fallback chain is deliberately narrow: we look up the actor-specific
 * row first, then `shared` if missing. We do NOT cascade the other way (a
 * `shared` read never returns a specific actor's checkpoint) — that would
 * leak cross-actor state on schedule-driven runs.
 */
export async function getCheckpoint(
  packageId: string,
  applicationId: string,
  scope: PersistenceScope,
): Promise<unknown | null> {
  const { actorType, actorId } = storageActor(scope);

  // Primary: actor-specific row.
  if (actorType !== "shared") {
    const [row] = await db
      .select({ content: packagePersistence.content })
      .from(packagePersistence)
      .where(
        and(
          eq(packagePersistence.packageId, packageId),
          eq(packagePersistence.applicationId, applicationId),
          eq(packagePersistence.kind, "checkpoint"),
          eq(packagePersistence.actorType, actorType),
          eq(packagePersistence.actorId, actorId!),
        ),
      )
      .limit(1);
    if (row) return row.content ?? null;
  }

  // Fallback: shared checkpoint.
  const [shared] = await db
    .select({ content: packagePersistence.content })
    .from(packagePersistence)
    .where(
      and(
        eq(packagePersistence.packageId, packageId),
        eq(packagePersistence.applicationId, applicationId),
        eq(packagePersistence.kind, "checkpoint"),
        eq(packagePersistence.actorType, "shared"),
        isNull(packagePersistence.actorId),
      ),
    )
    .limit(1);
  return shared?.content ?? null;
}

/**
 * Overwrite the checkpoint for a given scope. Targets the partial unique
 * index `pkp_checkpoint_unique` (WHERE kind='checkpoint') whose key is
 * `(package_id, application_id, actor_type, COALESCE(actor_id, '__shared__'))`.
 * The COALESCE replaces a Postgres-15-only `NULLS NOT DISTINCT` clause so
 * the same migration runs cleanly on PGlite (Tier 0).
 *
 * We hand-roll the SQL because drizzle's `onConflictDoUpdate` does not
 * support specifying the predicate of a partial unique index, nor an
 * expression-based conflict target. The `ON CONFLICT` columns/expression
 * here MUST match the index definition byte-for-byte.
 */
export async function upsertCheckpoint(
  packageId: string,
  applicationId: string,
  orgId: string,
  scope: PersistenceScope,
  content: unknown,
  runId: string | null,
): Promise<void> {
  const { actorType, actorId } = storageActor(scope);
  // jsonb expects valid JSON — sql.identifier paths aren't enough; we
  // bind via Drizzle's parameterised sql. Timestamps go through `NOW()`
  // because the `postgres.js` driver does not bind native `Date` objects
  // for raw `db.execute(sql\`…\`)` queries (no column-type metadata to
  // serialise against), and the column's `DEFAULT NOW()` is what every
  // other path uses anyway.
  const contentJson = sql`${JSON.stringify(content ?? null)}::jsonb`;

  await db.execute(sql`
    INSERT INTO ${packagePersistence}
      (package_id, application_id, org_id, kind, actor_type, actor_id, content, run_id, created_at, updated_at)
    VALUES
      (${packageId}, ${applicationId}, ${orgId}, 'checkpoint', ${actorType}, ${actorId}, ${contentJson}, ${runId}, NOW(), NOW())
    ON CONFLICT (package_id, application_id, actor_type, (COALESCE(actor_id, '__shared__'))) WHERE kind = 'checkpoint'
    DO UPDATE SET
      content    = EXCLUDED.content,
      run_id     = EXCLUDED.run_id,
      updated_at = NOW()
  `);
}

/** Delete the checkpoint row for a specific scope. Returns true if a row was deleted. */
export async function deleteCheckpoint(
  packageId: string,
  applicationId: string,
  scope: PersistenceScope,
): Promise<boolean> {
  const deleted = await db
    .delete(packagePersistence)
    .where(
      and(
        eq(packagePersistence.packageId, packageId),
        eq(packagePersistence.applicationId, applicationId),
        eq(packagePersistence.kind, "checkpoint"),
        buildScopeFilter(scope),
      ),
    )
    .returning({ id: packagePersistence.id });
  return deleted.length > 0;
}

// --- Memories ---------------------------------------------------------------

/**
 * Read the memory list visible to a scope — union of shared rows + rows
 * scoped to this exact actor, sorted createdAt ASC for prompt stability
 * (oldest first).
 */
export async function listMemories(
  packageId: string,
  applicationId: string,
  scope: PersistenceScope,
): Promise<Memory[]> {
  const { actorType, actorId } = storageActor(scope);

  // Shared rows are always visible; actor-specific rows only for this actor.
  const scopeFilter =
    actorType === "shared"
      ? // Scheduled / system runs see `shared` only. They never read another
        // actor's memories — cross-actor leakage is prevented here.
        and(eq(packagePersistence.actorType, "shared"), isNull(packagePersistence.actorId))
      : or(
          and(eq(packagePersistence.actorType, "shared"), isNull(packagePersistence.actorId)),
          and(
            eq(packagePersistence.actorType, actorType),
            eq(packagePersistence.actorId, actorId!),
          ),
        );

  const rows = await db
    .select({
      id: packagePersistence.id,
      content: packagePersistence.content,
      runId: packagePersistence.runId,
      createdAt: packagePersistence.createdAt,
      actorType: packagePersistence.actorType,
      actorId: packagePersistence.actorId,
    })
    .from(packagePersistence)
    .where(
      and(
        eq(packagePersistence.packageId, packageId),
        eq(packagePersistence.applicationId, applicationId),
        eq(packagePersistence.kind, "memory"),
        scopeFilter!,
      ),
    )
    .orderBy(asc(packagePersistence.createdAt));

  return rows as Memory[];
}

/**
 * Append memories for a scope, bounded at {@link MAX_MEMORIES_PER_SCOPE}
 * per `(package, app, scope)` and trimmed to {@link MAX_MEMORY_CONTENT}
 * characters per entry. Returns the count actually inserted.
 */
export async function addMemories(
  packageId: string,
  applicationId: string,
  orgId: string,
  scope: PersistenceScope,
  contents: unknown[],
  runId: string | null,
): Promise<number> {
  if (contents.length === 0) return 0;

  const { actorType, actorId } = storageActor(scope);

  const [row] = await db
    .select({ count: count() })
    .from(packagePersistence)
    .where(
      and(
        eq(packagePersistence.packageId, packageId),
        eq(packagePersistence.applicationId, applicationId),
        eq(packagePersistence.kind, "memory"),
        buildScopeFilter(scope),
      ),
    );
  const existing = row?.count ?? 0;
  const available = Math.max(0, MAX_MEMORIES_PER_SCOPE - existing);
  if (available === 0) return 0;

  const toInsert = contents.slice(0, available).map((c) => ({
    packageId,
    applicationId,
    orgId,
    kind: "memory" as const,
    actorType,
    actorId,
    content:
      typeof c === "string"
        ? (c.slice(0, MAX_MEMORY_CONTENT) as unknown as Record<string, unknown>)
        : (c as Record<string, unknown>),
    runId,
  }));

  if (toInsert.length === 0) return 0;

  const inserted = await db
    .insert(packagePersistence)
    .values(toInsert)
    .returning({ id: packagePersistence.id });
  return inserted.length;
}

/** Delete a single memory by id, scoped to (package, app). Returns true if a row was deleted. */
export async function deleteMemory(
  id: number,
  packageId: string,
  applicationId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(packagePersistence)
    .where(
      and(
        eq(packagePersistence.id, id),
        eq(packagePersistence.packageId, packageId),
        eq(packagePersistence.applicationId, applicationId),
        eq(packagePersistence.kind, "memory"),
      ),
    )
    .returning({ id: packagePersistence.id });
  return deleted.length > 0;
}

/**
 * Delete every memory row for (package, app), optionally narrowed to a
 * specific scope. Passing `undefined` for `scope` wipes memories across
 * every actor — used by the admin "clear all memories" route.
 */
export async function deleteAllMemories(
  packageId: string,
  applicationId: string,
  scope?: PersistenceScope,
): Promise<number> {
  const baseWhere = and(
    eq(packagePersistence.packageId, packageId),
    eq(packagePersistence.applicationId, applicationId),
    eq(packagePersistence.kind, "memory"),
    ...(scope ? [buildScopeFilter(scope)] : []),
  );

  const deleted = await db
    .delete(packagePersistence)
    .where(baseWhere)
    .returning({ id: packagePersistence.id });
  return deleted.length;
}
