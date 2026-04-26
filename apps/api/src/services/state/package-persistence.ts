// SPDX-License-Identifier: Apache-2.0

/**
 * Unified persistence service — one store covering both agent primitives:
 *
 * - Named pinned slots = `key=<key>`,   `pinned=true`   (single slot per key, upsert)
 *                       — `key='checkpoint'` is the legacy carry-over slot
 * - Pinned memos        = `key IS NULL`, `pinned=true`   (rendered in prompt)
 * - Archive memos       = `key IS NULL`, `pinned=false`  (recall_memory only)
 *
 * `key`/`pinned` are orthogonal storage attributes; the agent-facing AFPS
 * tools (`pin`, `note`) wrap them so external runners never see this
 * column shape.
 *
 * Storage-vocabulary note: `actor_type='user'` matches the `@afps-spec/schema`
 * wire format, while the in-process `Actor` type (`@appstrate/connect`) uses
 * `'member'` for dashboard users. This module speaks `Actor` at its public
 * boundary and translates at the DB boundary.
 *
 * See `docs/adr/ADR-011-checkpoint-unification.md` and
 * `docs/adr/ADR-012-memory-as-tool.md`.
 */

import { and, asc, count, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packagePersistence } from "@appstrate/db/schema";
import type { Actor } from "../../lib/actor.ts";
import { packagePersistenceContentSchema } from "../../lib/jsonb-schemas.ts";

/**
 * Validate any JSON value bound for `package_persistence.content` against
 * the shared Zod schema (JSON-safe + soft 64 KB cap). Throws on failure
 * with a path-prefixed message so callers (sidecar tool handlers, route
 * handlers) bubble a clear `invalidRequest` to the agent. Strings are
 * passed through unchanged — the AFPS `note` tool stores plain text.
 */
function assertValidContent(value: unknown, label: string): void {
  const parsed = packagePersistenceContentSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid ${label} content: ${issue?.message ?? "JSON validation failed"}`);
  }
}

// Per-entry char cap and per-scope row cap (archive memories only;
// pinned/checkpoint paths cap differently because they are bounded by
// design — at most one checkpoint, and pinned memories are written by
// admins or future tooling, not by agent loops).
export const MAX_MEMORY_CONTENT = 2000;
export const MAX_MEMORIES_PER_SCOPE = 100;

/** Reserved storage key for the legacy carry-over slot (`pin({ key: "checkpoint" })`). */
export const CHECKPOINT_KEY = "checkpoint";

/** Pattern enforced on agent-supplied pinned slot keys — must match the AFPS `pin` tool schema. */
export const PINNED_KEY_PATTERN = /^[a-z0-9_]+$/;
export const MAX_PINNED_KEY_LENGTH = 64;

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

export interface Memory {
  id: number;
  content: unknown;
  runId: string | null;
  createdAt: Date;
  pinned: boolean;
  actorType: "user" | "end_user" | "shared";
  actorId: string | null;
}

export interface PinnedSlotRow {
  id: number;
  key: string;
  content: unknown;
  runId: string | null;
  actorType: "user" | "end_user" | "shared";
  actorId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// --- Actor ↔ storage translation --------------------------------------------

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
 */
function buildScopeFilter(scope: PersistenceScope) {
  const { actorType, actorId } = storageActor(scope);
  return actorType === "shared"
    ? and(eq(packagePersistence.actorType, "shared"), isNull(packagePersistence.actorId))
    : and(eq(packagePersistence.actorType, actorType), eq(packagePersistence.actorId, actorId!));
}

/**
 * Visibility filter: shared rows always visible + actor-specific rows for
 * this exact actor. Used by every read path that must NOT leak across
 * actors. Pure scheduler/system runs (`scope.type === 'shared'`) collapse
 * to the shared bucket only.
 */
function buildVisibilityFilter(scope: PersistenceScope) {
  const { actorType, actorId } = storageActor(scope);
  if (actorType === "shared") {
    return and(eq(packagePersistence.actorType, "shared"), isNull(packagePersistence.actorId));
  }
  return or(
    and(eq(packagePersistence.actorType, "shared"), isNull(packagePersistence.actorId)),
    and(eq(packagePersistence.actorType, actorType), eq(packagePersistence.actorId, actorId!)),
  );
}

/**
 * Narrow an `Actor` (platform convention) into a `PersistenceScope`. Passing
 * `null` is the "scheduled / system run" path — maps to `shared`.
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

  if (actorType !== "shared") {
    const [row] = await db
      .select({ content: packagePersistence.content })
      .from(packagePersistence)
      .where(
        and(
          eq(packagePersistence.packageId, packageId),
          eq(packagePersistence.applicationId, applicationId),
          eq(packagePersistence.key, CHECKPOINT_KEY),
          eq(packagePersistence.actorType, actorType),
          eq(packagePersistence.actorId, actorId!),
        ),
      )
      .limit(1);
    if (row) return row.content ?? null;
  }

  const [shared] = await db
    .select({ content: packagePersistence.content })
    .from(packagePersistence)
    .where(
      and(
        eq(packagePersistence.packageId, packageId),
        eq(packagePersistence.applicationId, applicationId),
        eq(packagePersistence.key, CHECKPOINT_KEY),
        eq(packagePersistence.actorType, "shared"),
        isNull(packagePersistence.actorId),
      ),
    )
    .limit(1);
  return shared?.content ?? null;
}

/**
 * Overwrite the named pinned slot for a given scope. Targets the partial
 * unique index `pkp_key_unique` (WHERE key IS NOT NULL). Hand-rolled SQL
 * because Drizzle's `onConflictDoUpdate` doesn't support specifying an
 * expression-based conflict target, and the `ON CONFLICT` columns must
 * match the index byte-for-byte.
 *
 * `key` is validated against {@link PINNED_KEY_PATTERN} so a malformed
 * agent payload fails loud here rather than silently corrupting storage.
 * `key === "checkpoint"` is the legacy carry-over slot — every other key
 * is a Letta-style named pinned block.
 */
export async function upsertPinned(
  packageId: string,
  applicationId: string,
  orgId: string,
  scope: PersistenceScope,
  key: string,
  content: unknown,
  runId: string | null,
): Promise<void> {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > MAX_PINNED_KEY_LENGTH ||
    !PINNED_KEY_PATTERN.test(key)
  ) {
    throw new Error(
      `Invalid pinned slot key "${key}" — must match ${PINNED_KEY_PATTERN} and be ≤${MAX_PINNED_KEY_LENGTH} chars`,
    );
  }

  assertValidContent(content, key === CHECKPOINT_KEY ? "checkpoint" : "pinned slot");

  const { actorType, actorId } = storageActor(scope);
  const contentJson = sql`${JSON.stringify(content ?? null)}::jsonb`;

  await db.execute(sql`
    INSERT INTO ${packagePersistence}
      (package_id, application_id, org_id, key, pinned, actor_type, actor_id, content, run_id, created_at, updated_at)
    VALUES
      (${packageId}, ${applicationId}, ${orgId}, ${key}, true, ${actorType}, ${actorId}, ${contentJson}, ${runId}, NOW(), NOW())
    ON CONFLICT (package_id, application_id, actor_type, (COALESCE(actor_id, '__shared__')), key) WHERE key IS NOT NULL
    DO UPDATE SET
      content    = EXCLUDED.content,
      run_id     = EXCLUDED.run_id,
      updated_at = NOW()
  `);
}

/** Delete a single pinned slot row by id, scoped to (package, app). Covers any non-null key. */
export async function deletePinnedSlotById(
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
        sql`${packagePersistence.key} IS NOT NULL`,
      ),
    )
    .returning({ id: packagePersistence.id });
  return deleted.length > 0;
}

/** Delete the checkpoint row for a specific scope. */
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
        eq(packagePersistence.key, CHECKPOINT_KEY),
        buildScopeFilter(scope),
      ),
    )
    .returning({ id: packagePersistence.id });
  return deleted.length > 0;
}

/**
 * List every named pinned slot row for an agent (any non-null `key`).
 * Includes the legacy `checkpoint` carry-over slot alongside Letta-style
 * named blocks (`persona`, `goals`, …). Passing `scope: undefined` skips
 * the visibility filter — admin paths use that to inspect pinned slots
 * across every actor. Optionally narrows to slots written during a
 * specific run via `runId`.
 */
export async function listPinnedSlots(
  packageId: string,
  applicationId: string,
  scope?: PersistenceScope,
  runId?: string,
): Promise<PinnedSlotRow[]> {
  const rows = await db
    .select({
      id: packagePersistence.id,
      key: packagePersistence.key,
      content: packagePersistence.content,
      runId: packagePersistence.runId,
      actorType: packagePersistence.actorType,
      actorId: packagePersistence.actorId,
      createdAt: packagePersistence.createdAt,
      updatedAt: packagePersistence.updatedAt,
    })
    .from(packagePersistence)
    .where(
      and(
        eq(packagePersistence.packageId, packageId),
        eq(packagePersistence.applicationId, applicationId),
        sql`${packagePersistence.key} IS NOT NULL`,
        ...(scope ? [buildVisibilityFilter(scope)!] : []),
        ...(runId ? [eq(packagePersistence.runId, runId)] : []),
      ),
    )
    .orderBy(desc(packagePersistence.updatedAt));

  return rows as PinnedSlotRow[];
}

// --- Memories ---------------------------------------------------------------

/**
 * Read every memory visible to a scope. Includes both pinned + archive
 * rows — the UI tab uses this to show all memories regardless of
 * visibility tier. The agent's prompt path uses {@link listPinnedMemories}
 * instead.
 */
export async function listMemories(
  packageId: string,
  applicationId: string,
  scope: PersistenceScope,
  runId?: string,
): Promise<Memory[]> {
  const rows = await db
    .select({
      id: packagePersistence.id,
      content: packagePersistence.content,
      runId: packagePersistence.runId,
      createdAt: packagePersistence.createdAt,
      pinned: packagePersistence.pinned,
      actorType: packagePersistence.actorType,
      actorId: packagePersistence.actorId,
    })
    .from(packagePersistence)
    .where(
      and(
        eq(packagePersistence.packageId, packageId),
        eq(packagePersistence.applicationId, applicationId),
        isNull(packagePersistence.key),
        buildVisibilityFilter(scope)!,
        ...(runId ? [eq(packagePersistence.runId, runId)] : []),
      ),
    )
    .orderBy(asc(packagePersistence.createdAt));

  return rows as Memory[];
}

/**
 * Pinned memories — always rendered into the agent's system prompt.
 * Today no agent path writes these via `note` (default pinned=false);
 * the function exists so the prompt builder reads from a single,
 * intentional source instead of slicing `listMemories`. Named pinned
 * slots written by `pin({ key, content })` live in a separate column
 * shape (`key IS NOT NULL`) and are surfaced via `listPinnedSlots`.
 */
export async function listPinnedMemories(
  packageId: string,
  applicationId: string,
  scope: PersistenceScope,
): Promise<Memory[]> {
  const rows = await db
    .select({
      id: packagePersistence.id,
      content: packagePersistence.content,
      runId: packagePersistence.runId,
      createdAt: packagePersistence.createdAt,
      pinned: packagePersistence.pinned,
      actorType: packagePersistence.actorType,
      actorId: packagePersistence.actorId,
    })
    .from(packagePersistence)
    .where(
      and(
        eq(packagePersistence.packageId, packageId),
        eq(packagePersistence.applicationId, applicationId),
        isNull(packagePersistence.key),
        eq(packagePersistence.pinned, true),
        buildVisibilityFilter(scope)!,
      ),
    )
    .orderBy(asc(packagePersistence.createdAt));

  return rows as Memory[];
}

/**
 * Archive recall — backs the agent-facing `recall_memory` MCP tool.
 *
 * Returns archive memories (`pinned=false`) visible to the scope, optionally
 * narrowed by an ILIKE substring match on text content. This is intentionally
 * a flat substring search, not vector retrieval — see ADR-012 for why we
 * draw the line here. JSON content (non-string) is excluded from `query`
 * filtering since the index isn't text-typed; pass no query to get all
 * archive rows.
 *
 * Sorted `createdAt DESC` so the agent sees the most recent learnings
 * first; capped at `RECALL_LIMIT_MAX` (50) to bound the prompt-injection
 * cost when an agent passes a runaway limit.
 */
export const RECALL_LIMIT_DEFAULT = 10;
export const RECALL_LIMIT_MAX = 50;

export async function recallMemories(
  packageId: string,
  applicationId: string,
  scope: PersistenceScope,
  opts: { query?: string; limit?: number } = {},
): Promise<Memory[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? RECALL_LIMIT_DEFAULT, RECALL_LIMIT_MAX));

  const conditions = [
    eq(packagePersistence.packageId, packageId),
    eq(packagePersistence.applicationId, applicationId),
    isNull(packagePersistence.key),
    eq(packagePersistence.pinned, false),
    buildVisibilityFilter(scope)!,
  ];
  if (opts.query && opts.query.trim().length > 0) {
    // jsonb stringified for ILIKE: matches both string and structured
    // content without a separate index. Cheap on the modest row counts
    // we cap memories at; replace with FTS / pgvector if cardinality grows.
    conditions.push(ilike(sql`${packagePersistence.content}::text`, `%${opts.query.trim()}%`));
  }

  const rows = await db
    .select({
      id: packagePersistence.id,
      content: packagePersistence.content,
      runId: packagePersistence.runId,
      createdAt: packagePersistence.createdAt,
      pinned: packagePersistence.pinned,
      actorType: packagePersistence.actorType,
      actorId: packagePersistence.actorId,
    })
    .from(packagePersistence)
    .where(and(...conditions))
    .orderBy(desc(packagePersistence.createdAt), desc(packagePersistence.id))
    .limit(limit);

  return rows as Memory[];
}

/**
 * Append memories for a scope. Defaults to `pinned=false` (archive tier);
 * the AFPS `note` tool has no pinning parameter so every agent-written
 * memory lands in the archive. Bounded at {@link MAX_MEMORIES_PER_SCOPE}
 * per `(package, app, scope)` and trimmed to {@link MAX_MEMORY_CONTENT}
 * characters per entry.
 */
export async function addMemories(
  packageId: string,
  applicationId: string,
  orgId: string,
  scope: PersistenceScope,
  contents: unknown[],
  runId: string | null,
  opts: { pinned?: boolean } = {},
): Promise<number> {
  if (contents.length === 0) return 0;
  const pinned = opts.pinned ?? false;

  const { actorType, actorId } = storageActor(scope);

  const [row] = await db
    .select({ count: count() })
    .from(packagePersistence)
    .where(
      and(
        eq(packagePersistence.packageId, packageId),
        eq(packagePersistence.applicationId, applicationId),
        isNull(packagePersistence.key),
        buildScopeFilter(scope),
      ),
    );
  const existing = row?.count ?? 0;
  const available = Math.max(0, MAX_MEMORIES_PER_SCOPE - existing);
  if (available === 0) return 0;

  const toInsert = contents.slice(0, available).map((c) => {
    const trimmed =
      typeof c === "string"
        ? (c.slice(0, MAX_MEMORY_CONTENT) as unknown as Record<string, unknown>)
        : (c as Record<string, unknown>);
    assertValidContent(trimmed, "memory");
    return {
      packageId,
      applicationId,
      orgId,
      key: null,
      pinned,
      actorType,
      actorId,
      content: trimmed,
      runId,
    };
  });

  if (toInsert.length === 0) return 0;

  const inserted = await db
    .insert(packagePersistence)
    .values(toInsert)
    .returning({ id: packagePersistence.id });
  return inserted.length;
}

/** Delete a single memory by id, scoped to (package, app). */
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
        isNull(packagePersistence.key),
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
    isNull(packagePersistence.key),
    ...(scope ? [buildScopeFilter(scope)] : []),
  );

  const deleted = await db
    .delete(packagePersistence)
    .where(baseWhere)
    .returning({ id: packagePersistence.id });
  return deleted.length;
}
