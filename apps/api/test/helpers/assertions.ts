/**
 * Custom assertion helpers for database state verification.
 *
 * These helpers query the real test database to verify that
 * operations had the expected side effects.
 */
import { expect } from "bun:test";
import { db } from "./db.ts";
import { eq, and, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

/**
 * Assert that at least one row matching the given conditions exists in the table.
 *
 * @example
 * await assertDbHas(executions, eq(executions.id, "exec_123"));
 * await assertDbHas(packages, and(eq(packages.orgId, orgId), eq(packages.type, "flow")));
 */
export async function assertDbHas(table: PgTable, where: SQL): Promise<void> {
  const rows = await db.select().from(table).where(where).limit(1);
  expect(rows.length).toBeGreaterThan(0);
}

/**
 * Assert that no rows matching the given conditions exist in the table.
 *
 * @example
 * await assertDbMissing(executions, eq(executions.id, "exec_123"));
 */
export async function assertDbMissing(table: PgTable, where: SQL): Promise<void> {
  const rows = await db.select().from(table).where(where).limit(1);
  expect(rows).toHaveLength(0);
}

/**
 * Assert that exactly `count` rows matching the conditions exist.
 *
 * @example
 * await assertDbCount(executions, eq(executions.orgId, orgId), 3);
 */
export async function assertDbCount(table: PgTable, where: SQL, count: number): Promise<void> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(table)
    .where(where);
  expect(result[0]!.count).toBe(count);
}

/**
 * Get a single row from the table matching the conditions.
 * Throws if no row found (use assertDbMissing for that case).
 *
 * @example
 * const exec = await getDbRow(executions, eq(executions.id, "exec_123"));
 * expect(exec.status).toBe("success");
 */
export async function getDbRow<T extends PgTable>(
  table: T,
  where: SQL,
): Promise<T["$inferSelect"]> {
  const rows = await db.select().from(table as any).where(where).limit(1);
  expect(rows.length).toBeGreaterThan(0);
  return rows[0] as T["$inferSelect"];
}
