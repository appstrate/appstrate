// SPDX-License-Identifier: Apache-2.0

/**
 * Custom assertion helpers: database state verification, plus the RFC-9457
 * problem-body refusal shared by the RBAC route suites.
 */
import { expect } from "bun:test";
import { db } from "./db.ts";
import { sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

/** RFC-9457 problem body the API answers a refusal with. */
export interface ProblemBody {
  code: string;
  detail: string;
  param?: string;
  [extra: string]: unknown;
}

/**
 * Assert a refusal's status and, when given, its `code` and `param`. Returns
 * the parsed body so a test can pin any extra field (`member_count`, …) itself.
 *
 * @example
 * const problem = await expectProblem(res, 409, { code: "role_in_use" });
 * expect(problem.member_count).toBe(1);
 */
export async function expectProblem(
  res: Response,
  status: number,
  expected: { code?: string; param?: string } = {},
): Promise<ProblemBody> {
  expect(res.status, await res.clone().text()).toBe(status);
  const body = (await res.json()) as ProblemBody;
  if (expected.code !== undefined) expect(body.code).toBe(expected.code);
  if (expected.param !== undefined) expect(body.param).toBe(expected.param);
  return body;
}

/**
 * Assert that at least one row matching the given conditions exists in the table.
 *
 * @example
 * await assertDbHas(runs, eq(runs.id, "run_123"));
 * await assertDbHas(packages, and(eq(packages.orgId, orgId), eq(packages.type, "agent")));
 */
export async function assertDbHas(table: PgTable, where: SQL): Promise<void> {
  const rows = await db.select().from(table).where(where).limit(1);
  expect(rows.length).toBeGreaterThan(0);
}

/**
 * Assert that no rows matching the given conditions exist in the table.
 *
 * @example
 * await assertDbMissing(runs, eq(runs.id, "run_123"));
 */
export async function assertDbMissing(table: PgTable, where: SQL): Promise<void> {
  const rows = await db.select().from(table).where(where).limit(1);
  expect(rows).toHaveLength(0);
}

/**
 * Assert that exactly `count` rows matching the conditions exist.
 *
 * @example
 * await assertDbCount(runs, eq(runs.orgId, orgId), 3);
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
 * const run = await getDbRow(runs, eq(runs.id, "run_123"));
 * expect(run.status).toBe("success");
 */
export async function getDbRow<T extends PgTable>(
  table: T,
  where: SQL,
): Promise<T["$inferSelect"]> {
  const rows = await db
    .select()
    .from(table as any)
    .where(where)
    .limit(1);
  expect(rows.length).toBeGreaterThan(0);
  return rows[0] as T["$inferSelect"];
}
