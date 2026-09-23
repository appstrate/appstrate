// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0020-space-assignments-spaceid-key.sql` on a private
 * PGlite replayed to the head of the journal: stored assignments move from
 * `space_id` to `spaceId`, keep their order and role keys, and a second run
 * changes nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const MIGRATIONS_DIR = `${REPO_ROOT}/packages/db/drizzle`;
const SCRIPT = `${REPO_ROOT}/scripts/migration/0020-space-assignments-spaceid-key.sql`;

const ORG = "e0000000-0000-4000-8000-00000000d020";
const SPACE_A = "spc_d0200000-0000-4000-8000-000000000001";
const SPACE_B = "spc_d0200000-0000-4000-8000-000000000002";

let pg: PGlite;

async function replayJournal(db: PGlite): Promise<void> {
  const journal = (await Bun.file(`${MIGRATIONS_DIR}/meta/_journal.json`).json()) as {
    entries: { tag: string }[];
  };
  for (const entry of journal.entries) {
    const source = await Bun.file(`${MIGRATIONS_DIR}/${entry.tag}.sql`).text();
    await db.transaction(async (tx) => {
      await tx.exec(source.replaceAll("--> statement-breakpoint", ""));
    });
  }
}

async function value(query: string): Promise<unknown> {
  const { rows } = await pg.query<{ v: unknown }>(query);
  return rows[0]!.v;
}

const invitation = () =>
  value(`SELECT space_assignments AS v FROM org_invitations WHERE id = 'inv_0020'`);
const client = () =>
  value(`SELECT signup_space_assignments AS v FROM oauth_clients WHERE id = 'oac_0020'`);

beforeAll(async () => {
  pg = new PGlite();
  await replayJournal(pg);
  await pg.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('${ORG}', 'Twenty', 'twenty-0020');
    INSERT INTO org_invitations (id, token, email, org_id, role, status, expires_at, space_assignments)
      VALUES ('inv_0020', 'tok_0020', 'i-0020@example.com', '${ORG}', 'guest', 'pending',
              now() + interval '7 days',
              '[{"space_id":"${SPACE_A}","preset_role":"viewer"},{"space_id":"${SPACE_B}","custom_role_id":"srl_x"}]'::jsonb);
    INSERT INTO org_invitations (id, token, email, org_id, role, status, expires_at)
      VALUES ('inv_0020_empty', 'tok_0020_empty', 'e-0020@example.com', '${ORG}', 'member', 'pending',
              now() + interval '7 days');
    INSERT INTO oauth_clients (id, client_id, name, level, referenced_org_id, signup_role, signup_space_assignments, redirect_uris)
      VALUES ('oac_0020', 'oauth_0020', 'Signup', 'org', '${ORG}', 'guest',
              '[{"space_id":"${SPACE_B}","preset_role":"builder"}]'::jsonb, '{}');
  `);
  // A journal replay runs past the 15s default on a cold machine.
}, 300_000);

afterAll(async () => {
  await pg.close();
});

describe("scripts/migration/0020 — space assignments carry `spaceId`", () => {
  it("renames the key in both columns, keeping order and role keys, and is idempotent", async () => {
    await pg.exec(await Bun.file(SCRIPT).text());

    const expectedInvitation = [
      { spaceId: SPACE_A, preset_role: "viewer" },
      { spaceId: SPACE_B, custom_role_id: "srl_x" },
    ];
    expect(await invitation()).toEqual(expectedInvitation);
    expect(await client()).toEqual([{ spaceId: SPACE_B, preset_role: "builder" }]);
    expect(
      await value(`SELECT space_assignments AS v FROM org_invitations WHERE id = 'inv_0020_empty'`),
    ).toEqual([]);

    await pg.exec(await Bun.file(SCRIPT).text());
    expect(await invitation()).toEqual(expectedInvitation);
  });
});
