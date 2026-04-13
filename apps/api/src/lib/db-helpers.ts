// SPDX-License-Identifier: Apache-2.0

import { and, eq, type AnyColumn, type SQL } from "drizzle-orm";

/**
 * Shared helpers for system+DB merge patterns and partial update building.
 *
 * Used by org-models, org-proxies, org-provider-keys, and any service
 * that merges system-registry entries with database rows.
 */

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
    if (system.has(row.id)) continue;
    result.push(mapRow(row));
  }

  return result;
}

// --- Partial update-set builder ---

/**
 * Build a Drizzle-compatible update set from a partial data object.
 *
 * Always includes `updatedAt: new Date()`. Only keys whose value is
 * not `undefined` are included — allowing callers to pass the raw
 * request body without filtering.
 */
export function buildUpdateSet(data: Record<string, unknown>): Record<string, unknown> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) updates[key] = value;
  }
  return updates;
}
