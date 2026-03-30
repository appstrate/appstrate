/**
 * Shared helpers for system+DB merge patterns and partial update building.
 *
 * Used by org-models, org-proxies, org-provider-keys, and any service
 * that merges system-registry entries with database rows.
 */

// --- System + DB merge ---

export interface MergeSystemAndDbOptions<
  SystemDef,
  DbRow extends { id: string },
  Out,
> {
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
