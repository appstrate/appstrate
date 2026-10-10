// SPDX-License-Identifier: Apache-2.0

/**
 * `0089_connection_shares.sql` on the whole journal: a share row goes with its space and its
 * connection, and names a space of its connection's org; an org-scoped row's `origin_space_id` stays inside the
 * row's org and is nulled alone when that space is deleted; pins and org defaults carry no
 * `created_by`.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { journalPGlite } from "../helpers/journal.ts";

const ORG_A = "e0000000-0000-4000-8000-00000000a089";
const ORG_B = "e0000000-0000-4000-8000-00000000b089";
const A1 = "spc_0089_a1";
const A2 = "spc_0089_a2";
const B1 = "spc_0089_b1";
const ALICE = "usr_0089_alice";
const GMAIL = "@test/gmail-0089";

let pg: PGlite;
let seq = 0;

/** The SQLSTATE `sql` fails with; null if it lands. */
async function errorCode(sql: string): Promise<string | null> {
  try {
    await pg.exec(sql);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

async function count(sql: string): Promise<number> {
  const { rows } = await pg.query<{ n: number }>(sql);
  return Number(rows[0]?.n ?? 0);
}

/** A fresh org-scoped connection of Alice in ORG_A. */
async function insertConnection(originSpaceId: string | null = null): Promise<string> {
  seq += 1;
  const id = `c0890000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  await pg.exec(`
    INSERT INTO integration_connections
      (id, integration_package_id, auth_key, account_id, org_id, space_id, origin_space_id, user_id,
       credentials_encrypted, label)
    VALUES ('${id}', '${GMAIL}', 'primary', 'acct-${seq}', '${ORG_A}', NULL,
      ${originSpaceId === null ? "NULL" : `'${originSpaceId}'`}, '${ALICE}', 'x', 'Connexion ${seq}');
  `);
  return id;
}

/** A fresh non-default space of ORG_A. */
async function insertSpace(): Promise<string> {
  seq += 1;
  const id = `spc_0089_tmp_${seq}`;
  await pg.exec(`INSERT INTO spaces (id, org_id, name) VALUES ('${id}', '${ORG_A}', 'Tmp ${seq}')`);
  return id;
}

beforeAll(async () => {
  pg = await journalPGlite();
  await pg.exec(`
    INSERT INTO organizations (id, name, slug) VALUES
      ('${ORG_A}', 'A89', 'a-89'), ('${ORG_B}', 'B89', 'b-89');
    INSERT INTO spaces (id, org_id, name, is_default) VALUES
      ('${A1}', '${ORG_A}', 'A1', true), ('${A2}', '${ORG_A}', 'A2', false),
      ('${B1}', '${ORG_B}', 'B1', true);
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
      ('${ALICE}', 'Alice', 'a-0089@example.com', true, now(), now());
    INSERT INTO packages (id, type) VALUES ('${GMAIL}', 'integration');
  `);
  // A journal replay runs past the suite's 15s per-test timeout (`--timeout`).
}, 300_000);

afterAll(async () => {
  await pg.close();
});

describe("0089 — connection shares", () => {
  it("drops a share when its space is deleted", async () => {
    const conn = await insertConnection();
    const space = await insertSpace();
    await pg.exec(
      `INSERT INTO integration_connection_shares (connection_id, space_id, org_id)
       VALUES ('${conn}', '${space}', '${ORG_A}')`,
    );
    await pg.exec(`DELETE FROM spaces WHERE id = '${space}'`);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM integration_connection_shares WHERE connection_id = '${conn}'`,
      ),
    ).toBe(0);
  });

  it("drops a share when its connection is deleted", async () => {
    const conn = await insertConnection();
    await pg.exec(
      `INSERT INTO integration_connection_shares (connection_id, space_id, org_id) VALUES ('${conn}', '${A2}', '${ORG_A}')`,
    );
    await pg.exec(`DELETE FROM integration_connections WHERE id = '${conn}'`);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM integration_connection_shares WHERE connection_id = '${conn}'`,
      ),
    ).toBe(0);
  });

  it("refuses a duplicate (connection, space) share", async () => {
    const conn = await insertConnection();
    const insert = `INSERT INTO integration_connection_shares (connection_id, space_id, org_id) VALUES ('${conn}', '${A2}', '${ORG_A}')`;
    expect(await errorCode(insert)).toBeNull();
    expect(await errorCode(insert)).toBe("23505");
  });

  it("refuses a share into a space of another org, whichever org the row names", async () => {
    const conn = await insertConnection();
    const share = (orgId: string) =>
      `INSERT INTO integration_connection_shares (connection_id, space_id, org_id) VALUES ('${conn}', '${B1}', '${orgId}')`;
    // The space's org: the connection is not of that org.
    expect(await errorCode(share(ORG_B))).toBe("23503");
    // The connection's org: the space is not of that org.
    expect(await errorCode(share(ORG_A))).toBe("23503");
  });

  it("refuses an origin space of another org", async () => {
    const conn = await insertConnection();
    expect(
      await errorCode(
        `UPDATE integration_connections SET origin_space_id = '${B1}' WHERE id = '${conn}'`,
      ),
    ).toBe("23503");
  });

  it("nulls origin_space_id alone when the origin space is deleted", async () => {
    const space = await insertSpace();
    const conn = await insertConnection(space);
    await pg.exec(`DELETE FROM spaces WHERE id = '${space}'`);
    const { rows } = await pg.query<{ origin_space_id: string | null; org_id: string }>(
      `SELECT origin_space_id, org_id FROM integration_connections WHERE id = '${conn}'`,
    );
    expect(rows).toEqual([{ origin_space_id: null, org_id: ORG_A }]);
  });

  it("drops created_by from pins and org defaults and keeps shared_space_ids for 0044", async () => {
    expect(
      await count(
        `SELECT count(*)::int AS n FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'created_by'
           AND table_name IN ('integration_pins', 'integration_org_defaults')`,
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'integration_connections'
           AND column_name = 'shared_space_ids'`,
      ),
    ).toBe(1);
  });
});
