// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * The `ee_*` tables follow the platform's Zone 2 split
 * (`docs/CASING_CONVENTIONS.md`), checked the way
 * `packages/db/test/schema-casing.test.ts` checks the core schema — which this
 * module may not import.
 */

import { describe, expect, it } from "bun:test";
import { getTableColumns, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../drizzle/schema.ts";

const TS_KEY = /^[a-z][a-zA-Z0-9]*$/;
const SQL_NAME = /^[a-z][a-z0-9_]*$/;

describe("ee schema casing", () => {
  it("names every table, column and constraint by the Zone 2 split", () => {
    const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));
    const offenders: string[] = [];
    for (const table of tables) {
      const config = getTableConfig(table);
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
        if (!name || !SQL_NAME.test(name))
          offenders.push(`${config.name}: SQL identifier "${name}"`);
      }
      for (const key of Object.keys(getTableColumns(table))) {
        if (!TS_KEY.test(key)) offenders.push(`${config.name}: TS column key "${key}"`);
      }
    }
    expect(tables.length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
