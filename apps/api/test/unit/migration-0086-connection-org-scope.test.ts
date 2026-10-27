// SPDX-License-Identifier: Apache-2.0

/**
 * `0086_connection_org_scope.sql` on a database at `0085`: every connection gets its space's org,
 * `shared_with_org` folds into `shared_space_ids` (its own space or nothing), each new CHECK
 * refuses the shape it exists for, labels become unique per owner, and an auto-provisioned OAuth
 * client may sit at org tier, one per (org, tier, integration, auth, issuer). Widening existing
 * rows is `scripts/migration/0041`'s (`scripts/test/0041-widen-connections-to-org-scope.test.ts`).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { journalPGlite } from "../helpers/journal.ts";

const MIGRATION = resolve(
  import.meta.dir,
  "../../../../packages/db/drizzle/0086_connection_org_scope.sql",
);
const REPLAY_THROUGH = "0085_runs_integrations_unbound";

const ORG_A = "e0000000-0000-4000-8000-00000000a086";
const ORG_B = "e0000000-0000-4000-8000-00000000b086";
const A1 = "spc_a0860000-0000-4000-8000-000000000001";
const A2 = "spc_a0860000-0000-4000-8000-000000000002";
const A3 = "spc_a0860000-0000-4000-8000-000000000003";
const B1 = "spc_b0860000-0000-4000-8000-000000000001";
const ALICE = "usr_0086_alice";
const BOB = "usr_0086_bob";
const ERIN = "eu_0086_erin";
const GMAIL = "@acme0086/gmail";

const conn = (n: number) => `c0860000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let pg: PGlite;

/** The SQLSTATE `sql` fails with; null if it lands. */
async function errorCode(sql: string): Promise<string | null> {
  try {
    await pg.exec(sql);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

const update = (n: number, set: string) =>
  `UPDATE integration_connections SET ${set} WHERE id = '${conn(n)}'`;

/** A user-owned connection row of org A, after the migration. */
const insertConnection = (n: number, owner: string, space: string | null, label: string) =>
  `INSERT INTO integration_connections
     (id, integration_package_id, auth_key, account_id, org_id, space_id, user_id, credentials_encrypted, label)
   VALUES ('${conn(n)}', '${GMAIL}', 'primary', 'acct-${n}', '${ORG_A}', ${
     space === null ? "NULL" : `'${space}'`
   }, '${owner}', 'x', '${label}')`;

const insertAutoClient = (org: string, space: string | null, issuer: string | null) =>
  `INSERT INTO integration_oauth_clients
     (org_id, space_id, integration_package_id, auth_key, client_id, client_secret_encrypted,
      token_endpoint_auth_method, auto_provisioned, issuer)
   VALUES ('${org}', ${space === null ? "NULL" : `'${space}'`}, '${GMAIL}', 'primary',
           'dcr-${crypto.randomUUID().slice(0, 8)}', '', 'none', true,
           ${issuer === null ? "NULL" : `'${issuer}'`})`;

beforeAll(async () => {
  pg = await journalPGlite({ through: REPLAY_THROUGH });
  const legacy = (n: number, space: string, owner: string, label: string, shared: boolean) =>
    `('${conn(n)}', '${GMAIL}', 'primary', 'acct-${n}', '${space}', ${
      owner.startsWith("eu_") ? `NULL, '${owner}'` : `'${owner}', NULL`
    }, 'x', '${label}', ${shared})`;
  await pg.exec(`
    INSERT INTO organizations (id, name, slug) VALUES
      ('${ORG_A}', 'Zero86 A', 'zero-86-a'), ('${ORG_B}', 'Zero86 B', 'zero-86-b');
    INSERT INTO spaces (id, org_id, name, is_default) VALUES
      ('${A1}', '${ORG_A}', 'A1', true), ('${A2}', '${ORG_A}', 'A2', false),
      ('${B1}', '${ORG_B}', 'B1', true);
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
      ('${ALICE}', 'Alice', 'a-0086@example.com', true, now(), now()),
      ('${BOB}', 'Bob', 'b-0086@example.com', true, now(), now());
    INSERT INTO end_users (id, space_id, org_id) VALUES ('${ERIN}', '${A1}', '${ORG_A}');
    INSERT INTO packages (id, type) VALUES ('${GMAIL}', 'integration');
    INSERT INTO integration_connections
      (id, integration_package_id, auth_key, account_id, space_id, user_id, end_user_id,
       credentials_encrypted, label, shared_with_org)
    VALUES
      ${legacy(1, A1, ALICE, "Work", true)},
      ${legacy(2, A1, BOB, "Bob", false)},
      ${legacy(3, B1, ALICE, "Work", false)},
      ${legacy(4, A1, ERIN, "Erin", false)},
      ${legacy(5, A2, ALICE, "Work", false)};
  `);
  // A space-tier DCR client, the only tier 0085 allowed.
  await pg.exec(insertAutoClient(ORG_A, A1, null));
  const source = await Bun.file(MIGRATION).text();
  await pg.transaction(async (tx) => {
    await tx.exec(source.replaceAll("--> statement-breakpoint", ""));
  });
  // A journal replay runs past the suite's 15s per-test timeout (`--timeout`).
}, 300_000);

afterAll(async () => {
  await pg.close();
});

describe("0086 — connection org scope", () => {
  it("gives each connection its space's org and folds shared_with_org into its own space", async () => {
    const { rows } = await pg.query<{
      id: string;
      org_id: string;
      space_id: string | null;
      origin_space_id: string | null;
      shared_space_ids: string[];
    }>(
      `SELECT id, org_id, space_id, origin_space_id, shared_space_ids
         FROM integration_connections ORDER BY id`,
    );
    const row = (id: string, org: string, space: string, shared: string[]) => ({
      id,
      org_id: org,
      space_id: space,
      origin_space_id: null,
      shared_space_ids: shared,
    });
    expect(rows).toEqual([
      row(conn(1), ORG_A, A1, [A1]),
      row(conn(2), ORG_A, A1, []),
      row(conn(3), ORG_B, B1, []),
      row(conn(4), ORG_A, A1, []),
      row(conn(5), ORG_A, A2, []),
    ]);
    const columns = await pg.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'integration_connections' AND column_name = 'shared_with_org'`,
    );
    expect(columns.rows).toEqual([]);
  });

  it("refuses an end user's share or org scope", async () => {
    expect(await errorCode(update(4, `shared_space_ids = ARRAY['${A1}']`))).toBe("23514");
    expect(await errorCode(update(4, "space_id = NULL"))).toBe("23514");
  });

  it("refuses an origin on a space-scoped row, and a share of it outside its space", async () => {
    expect(await errorCode(update(2, `origin_space_id = '${A1}'`))).toBe("23514");
    expect(await errorCode(update(2, `shared_space_ids = ARRAY['${A2}']`))).toBe("23514");
    expect(await errorCode(update(2, `shared_space_ids = ARRAY['${A1}']`))).toBeNull();
  });

  it("lets an org-scoped row keep an origin and be shared with several spaces", async () => {
    expect(
      await errorCode(
        update(
          5,
          `space_id = NULL, origin_space_id = '${A2}', shared_space_ids = ARRAY['${A1}', '${A2}']`,
        ),
      ),
    ).toBeNull();
    // Deleting the origin space keeps the row, without its origin.
    await pg.exec(`
      INSERT INTO spaces (id, org_id, name) VALUES ('${A3}', '${ORG_A}', 'Gone');
      UPDATE integration_connections SET origin_space_id = '${A3}' WHERE id = '${conn(5)}';
      DELETE FROM spaces WHERE id = '${A3}';
    `);
    const { rows } = await pg.query(
      `SELECT origin_space_id FROM integration_connections WHERE id = '${conn(5)}'`,
    );
    expect(rows).toEqual([{ origin_space_id: null }]);
  });

  it("makes a label unique per owner and scope, not per space", async () => {
    // Another owner's label in the same space no longer blocks one …
    expect(await errorCode(update(2, "label = 'Work'"))).toBeNull();
    // … the owner's own does, in a space as at org scope …
    expect(await errorCode(insertConnection(10, ALICE, A1, "Work"))).toBe("23505");
    expect(await errorCode(insertConnection(11, ALICE, null, "Org"))).toBeNull();
    expect(await errorCode(insertConnection(12, ALICE, null, "Org"))).toBe("23505");
    // … while another scope is another key.
    expect(await errorCode(insertConnection(13, ALICE, A1, "Org"))).toBeNull();
  });

  it("allows one auto-provisioned client per (org, tier, integration, auth, issuer)", async () => {
    expect(await errorCode(insertAutoClient(ORG_A, null, null))).toBeNull();
    expect(await errorCode(insertAutoClient(ORG_A, null, null))).toBe("23505");
    expect(await errorCode(insertAutoClient(ORG_A, null, "https://as.example"))).toBeNull();
    expect(await errorCode(insertAutoClient(ORG_B, null, null))).toBeNull();
    expect(await errorCode(insertAutoClient(ORG_A, A1, null))).toBe("23505");
    expect(await errorCode(insertAutoClient(ORG_A, A2, null))).toBeNull();
  });
});
