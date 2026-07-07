// SPDX-License-Identifier: Apache-2.0

import { and, eq, ne, type AnyColumn, type SQL } from "drizzle-orm";
import { type PgColumn, type PgTable } from "drizzle-orm/pg-core";
import { db } from "@appstrate/db/client";
import { organizations } from "@appstrate/db/schema";
import { notFound } from "./errors.ts";
import { logger } from "./logger.ts";

/**
 * Shared helpers for system+DB merge patterns and partial update building.
 *
 * Used by org-models, org-proxies, model-provider-credentials, and any
 * service that merges system-registry entries with database rows.
 */

/** The transaction handle passed to a `db.transaction` callback. */
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// --- Scoped WHERE builder ---

/**
 * Drizzle table shape required by `scopedWhere`: must expose an `orgId`
 * column, and optionally an `applicationId` column for app-scoped tables.
 */
export interface OrgScopedTable {
  orgId: AnyColumn;
  applicationId?: AnyColumn;
}

export interface ScopedWhereOptions {
  orgId: string | undefined;
  applicationId?: string | undefined;
  /** Additional conditions to AND with the scope (undefined entries are skipped). */
  extra?: (SQL | undefined)[];
}

/**
 * Build a Drizzle `where` expression that scopes a query to an organization
 * (and optionally an application), plus any extra conditions.
 *
 * Undefined values are silently skipped — callers with optional app-scoping
 * can pass `applicationId` conditionally. Returns `undefined` if no
 * conditions remain (rare, but compatible with `.where(cond)` signatures).
 *
 * Examples:
 * ```ts
 * scopedWhere(runs, { orgId })
 * // → eq(runs.orgId, orgId)
 *
 * scopedWhere(runs, { orgId, applicationId })
 * // → and(eq(runs.orgId, orgId), eq(runs.applicationId, applicationId))
 *
 * scopedWhere(runs, { orgId, applicationId, extra: [eq(runs.id, id)] })
 * // → and(eq(runs.orgId, orgId), eq(runs.applicationId, applicationId), eq(runs.id, id))
 * ```
 */
export function scopedWhere(table: OrgScopedTable, opts: ScopedWhereOptions): SQL | undefined {
  const conditions: SQL[] = [];

  if (opts.orgId !== undefined) {
    conditions.push(eq(table.orgId, opts.orgId));
  }

  if (opts.applicationId !== undefined && table.applicationId !== undefined) {
    conditions.push(eq(table.applicationId, opts.applicationId));
  }

  if (opts.extra) {
    for (const cond of opts.extra) {
      if (cond !== undefined) conditions.push(cond);
    }
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return and(...conditions);
}

// --- UUID shape guard ---

/** RFC 4122 shape. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when `value` is UUID-shaped. Use before comparing a caller-supplied id
 * against a `uuid` column: Postgres raises `22P02 invalid_text_representation`
 * on a non-UUID literal, which would otherwise surface as a 500 instead of a
 * clean "not found". A non-UUID id can never be a row PK, so it's a miss.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * True when a DB error is Postgres `22P02` (invalid_text_representation) — the
 * class raised when a non-UUID string is compared against a `uuid` column.
 * Matches on the SQLSTATE code with a message fallback, and walks the `cause`
 * chain since Drizzle wraps the driver error in a `DrizzleQueryError`. Covers
 * both the Tier-0 embedded driver (PGlite) and a real server (postgres.js).
 */
export function isInvalidTextRepresentation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current != null && depth < 5; depth++) {
    if (typeof current === "object") {
      if ((current as { code?: unknown }).code === "22P02") return true;
      const message = (current as { message?: unknown }).message;
      if (typeof message === "string" && message.includes("invalid input syntax for type uuid")) {
        return true;
      }
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return false;
}

// --- System + DB merge ---

export interface MergeSystemAndDbOptions<SystemDef, DbRow extends { id: string }, Out> {
  /** System registry map (id → definition). */
  system: ReadonlyMap<string, SystemDef>;
  /** Database rows for the current org. */
  rows: DbRow[];
  /** Map a system entry to the output type. */
  mapSystem: (id: string, def: SystemDef) => Out;
  /** Map a DB row to the output type. */
  mapRow: (row: DbRow) => Out;
}

/**
 * Merge system-registry entries with org-scoped DB rows.
 *
 * System entries appear first. DB rows whose `id` collides with a system
 * entry are silently skipped (system always wins).
 */
export function mergeSystemAndDb<SystemDef, DbRow extends { id: string }, Out>(
  opts: MergeSystemAndDbOptions<SystemDef, DbRow, Out>,
): Out[] {
  const { system, rows, mapSystem, mapRow } = opts;
  const result: Out[] = [];

  for (const [id, def] of system) {
    result.push(mapSystem(id, def));
  }

  for (const row of rows) {
    if (system.has(row.id)) {
      // A DB row colliding with a system id is dropped (system wins). System
      // ids are slugs and DB ids are UUIDs, so this is near-impossible — log it
      // if it ever happens so the masked row isn't a silent mystery.
      logger.debug("[mergeSystemAndDb] DB row dropped — id collides with a system entry", {
        id: row.id,
      });
      continue;
    }
    result.push(mapRow(row));
  }

  return result;
}

// --- Partial update-set builder ---

/**
 * Tenant-scoping and immutable columns that must NEVER be settable from a
 * caller-supplied data object — overwriting `orgId`/`applicationId` would move
 * a row across tenants, and `id`/`createdAt` are write-once. Blocked
 * unconditionally as a safety net even when a caller forgets to pass an
 * explicit `allowedKeys` allowlist. Both TS field names and their snake_case
 * SQL aliases are listed so a raw wire body can't slip either past.
 */
const IMMUTABLE_UPDATE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "orgId",
  "org_id",
  "applicationId",
  "application_id",
  "createdAt",
  "created_at",
]);

/**
 * Build a Drizzle-compatible update set from a partial data object.
 *
 * Always includes `updatedAt: new Date()`. Keys whose value is `undefined`
 * are skipped.
 *
 * Pass `allowedKeys` — the explicit set of columns a route may update — so a
 * caller cannot mass-assign tenant/immutable columns by handing the raw
 * request body straight through (e.g. `{ name, orgId }` silently rewriting
 * `orgId` cross-tenant). When `allowedKeys` is omitted, a hard-coded
 * `IMMUTABLE_UPDATE_KEYS` blocklist still strips the dangerous columns as a
 * safety net, but passing an allowlist is strongly preferred.
 */
export function buildUpdateSet(
  data: Record<string, unknown>,
  allowedKeys?: readonly string[],
): Record<string, unknown> {
  const allow = allowedKeys ? new Set(allowedKeys) : null;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (allow) {
      if (!allow.has(key)) continue;
    } else if (IMMUTABLE_UPDATE_KEYS.has(key)) {
      continue;
    }
    updates[key] = value;
  }
  return updates;
}

// --- One-default invariant ---

export interface SetExactlyOneDefaultOptions {
  /** Clear `is_default` across the whole scope. Runs first. */
  clear: (tx: DbTransaction) => Promise<unknown>;
  /**
   * Flag the single chosen row as default. Runs after `clear`. Pass `null` to
   * clear only — e.g. when promoting a system default, which carries no DB row
   * and is handled by the resolution cascade.
   */
  set: ((tx: DbTransaction) => Promise<unknown>) | null;
}

/**
 * Atomically enforce the "exactly one default" invariant for a per-row
 * `is_default` flag (currently the integration OAuth clients surface; org models
 * and proxies use the `createDefaultPointer` org-column pattern instead): clear
 * every default in the scope, then optionally flag one target — both in a SINGLE
 * transaction. The transaction matters: a partial-unique `idx_*_one_default`
 * index must never transiently see two defaults, and a crash mid-flip must never
 * leave the scope in a half-written state. `clear` always runs before `set`.
 */
export async function setExactlyOneDefault(opts: SetExactlyOneDefaultOptions): Promise<void> {
  await db.transaction(async (tx) => {
    await opts.clear(tx);
    if (opts.set) await opts.set(tx);
  });
}

// --- Org-level default pointer (system id OR custom row UUID) ---

/**
 * The four pointer operations shared by every org-level "default pointer"
 * surface. The pointer is a nullable `text` column on `organizations` naming
 * either a SYSTEM entry id or a custom DB row UUID (or `null` — the resolver
 * then falls to the system cascade). `org-models` and `org-proxies` store this
 * exact shape; this folds their byte-identical pointer logic into one place.
 */
export interface DefaultPointer {
  /** Read the pointer (system id, custom UUID, or null). Single read path. */
  getDefaultId(orgId: string): Promise<string | null>;
  /**
   * Inside the caller's insert transaction: when `newRowId` is the org's very
   * first row of this domain table, point the org default at it; no-op
   * otherwise. Counts rows EXCLUDING `newRowId`, so it must run AFTER the
   * insert — equivalent to the pre-insert `isFirst` check it replaces.
   */
  promoteIfFirst(tx: DbTransaction, orgId: string, newRowId: string): Promise<void>;
  /**
   * Set (or clear, with `null`) the pointer. A system id is trusted via
   * `isSystem`; a custom id must be UUID-shaped AND an org-owned row, else
   * `notFound` is thrown. The `isUuid` guard avoids a 22P02 on the uuid column.
   */
  setDefault(orgId: string, id: string | null): Promise<void>;
  /**
   * Inside the caller's transaction: point the org default at `id` ONLY when no
   * default is set yet; no-op when one already exists. Returns whether it set.
   * Covers the seed path's multi-insert case (where `promoteIfFirst`'s
   * single-new-row count doesn't apply), so callers never hand-roll the
   * pointer-column read/write — keeping the field name owned here.
   */
  setDefaultIfUnset(tx: DbTransaction, orgId: string, id: string): Promise<boolean>;
  /**
   * After a row is deleted, clear the pointer iff it still names the deleted id
   * — so a now-dangling pointer never outlives its row.
   */
  clearDanglingPointer(orgId: string, deletedId: string): Promise<void>;
}

/** Org `organizations` columns usable as a default pointer (nullable `text`). */
type OrgPointerField = "defaultModelId" | "defaultProxyId";

export interface CreateDefaultPointerOptions {
  /** Domain table whose rows the pointer can name (needs a `uuid` `id` column). */
  table: PgTable & { id: PgColumn };
  /**
   * The Drizzle field name of the `organizations` pointer column. The column
   * itself is derived from this (`organizations[pointerField]`) so the field and
   * column can never desync — a single source of truth.
   */
  pointerField: OrgPointerField;
  /** True when `id` names a SYSTEM entry (carries no DB row). */
  isSystem: (id: string) => boolean;
  /**
   * Build the scope WHERE: with `rowId` → the org-owned-row ownership lookup;
   * without → the org-wide scope. Each caller keeps its existing scoping
   * (`scopedWhere` for models, plain `and(eq(...))` for proxies).
   */
  scopeWhere: (orgId: string, rowId?: string) => SQL | undefined;
  /** Capitalised entity name for the `notFound` message (e.g. `"Model"`). */
  entityName: string;
}

export function createDefaultPointer(opts: CreateDefaultPointerOptions): DefaultPointer {
  const { table, pointerField, isSystem, scopeWhere, entityName } = opts;
  // Derive the column from the field — one source of truth, no desync.
  const pointerColumn: PgColumn = organizations[pointerField];

  async function getDefaultId(orgId: string): Promise<string | null> {
    const [row] = await db
      .select({ value: pointerColumn })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    return row?.value ?? null;
  }

  async function promoteIfFirst(tx: DbTransaction, orgId: string, newRowId: string): Promise<void> {
    const existing = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(scopeWhere(orgId), ne(table.id, newRowId)))
      .limit(1);
    if (existing.length === 0) {
      const set: Record<string, unknown> = { [pointerField]: newRowId, updatedAt: new Date() };
      await tx.update(organizations).set(set).where(eq(organizations.id, orgId));
    }
  }

  async function setDefault(orgId: string, id: string | null): Promise<void> {
    if (id !== null && !isSystem(id)) {
      // A non-UUID id can't be a custom row PK — reject without hitting the
      // `uuid` column (which would raise 22P02 → 500 instead of a clean 404).
      const [row] = isUuid(id)
        ? await db.select({ id: table.id }).from(table).where(scopeWhere(orgId, id)).limit(1)
        : [];
      if (!row) throw notFound(`${entityName} '${id}' not found`);
    }
    const set: Record<string, unknown> = { [pointerField]: id, updatedAt: new Date() };
    await db.update(organizations).set(set).where(eq(organizations.id, orgId));
  }

  async function setDefaultIfUnset(tx: DbTransaction, orgId: string, id: string): Promise<boolean> {
    const [org] = await tx
      .select({ value: pointerColumn })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (org?.value) return false; // a default already exists — leave it.
    const set: Record<string, unknown> = { [pointerField]: id, updatedAt: new Date() };
    await tx.update(organizations).set(set).where(eq(organizations.id, orgId));
    return true;
  }

  async function clearDanglingPointer(orgId: string, deletedId: string): Promise<void> {
    const set: Record<string, unknown> = { [pointerField]: null, updatedAt: new Date() };
    await db
      .update(organizations)
      .set(set)
      .where(and(eq(organizations.id, orgId), eq(pointerColumn, deletedId)));
  }

  return { getDefaultId, promoteIfFirst, setDefault, setDefaultIfUnset, clearDanglingPointer };
}
