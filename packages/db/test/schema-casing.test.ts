// SPDX-License-Identifier: Apache-2.0

/**
 * Zone 2 of `docs/CASING_CONVENTIONS.md`: a Drizzle column is camelCase in TS
 * and snake_case in SQL, and every SQL identifier the schema names (table,
 * column, index, foreign key, unique, primary key, check) is snake_case.
 */

import { describe, expect, it } from "bun:test";
import { getTableColumns, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../src/schema/index.ts";

const TS_KEY = /^[a-z][a-zA-Z0-9]*$/;
const SQL_NAME = /^[a-z][a-z0-9_]*$/;

function casingOffenders(module: Record<string, unknown>): string[] {
  const offenders: string[] = [];
  for (const value of Object.values(module)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    const sqlNames = [
      config.name,
      ...config.columns.map((c) => c.name),
      ...config.indexes.map((i) => i.config.name),
      ...config.foreignKeys.map((fk) => fk.getName()),
      ...config.uniqueConstraints.map((u) => u.getName()),
      ...config.primaryKeys.map((pk) => pk.getName()),
      ...config.checks.map((c) => c.name),
    ];
    for (const name of sqlNames) {
      if (!name || !SQL_NAME.test(name)) offenders.push(`${config.name}: SQL identifier "${name}"`);
    }
    for (const key of Object.keys(getTableColumns(value))) {
      if (!TS_KEY.test(key)) offenders.push(`${config.name}: TS column key "${key}"`);
    }
  }
  return offenders;
}

describe("core schema casing", () => {
  it("names every table, column and constraint by the Zone 2 split", () => {
    expect(casingOffenders(schema)).toEqual([]);
  });

  it("finds tables to check", () => {
    expect(Object.values(schema).filter((v) => is(v, PgTable)).length).toBeGreaterThan(40);
  });
});
