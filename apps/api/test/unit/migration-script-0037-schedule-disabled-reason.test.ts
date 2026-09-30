// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0037-schedule-disabled-reason-backfill.sql` on a private PGlite replayed to
 * the current schema: a schedule `0080` labelled `user` whose member actor is no longer in the
 * organization becomes `actor_left_org`; every other row keeps its reason, and a rerun is a no-op.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { replayJournal } from "../helpers/journal.ts";

const SCRIPT = resolve(
  import.meta.dir,
  "../../../../scripts/migration/0037-schedule-disabled-reason-backfill.sql",
);

const ORG = "e0000000-0000-4000-8000-00000000d037";
const SPACE = "spc_d0370000-0000-4000-8000-000000000001";
const ALICE = "usr_0037_alice";
const BOB = "usr_0037_bob";
const AGENT = "@acme0037/agent";

const pg = new PGlite();
const script = await Bun.file(SCRIPT).text();

async function reasons(): Promise<Record<string, string | null>> {
  const { rows } = await pg.query<{ id: string; disabled_reason: string | null }>(
    "SELECT id, disabled_reason FROM package_schedules ORDER BY id",
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.disabled_reason]));
}

beforeAll(async () => {
  await replayJournal(pg);
  // Bob left the organization; Alice is still a member.
  await pg.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('${ORG}', 'Zero37', 'zero-37');
    INSERT INTO spaces (id, org_id, name, is_default) VALUES ('${SPACE}', '${ORG}', 'Default', true);
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
      ('${ALICE}', 'Alice', 'a-0037@example.com', true, now(), now()),
      ('${BOB}', 'Bob', 'b-0037@example.com', true, now(), now());
    INSERT INTO org_members (org_id, user_id, role) VALUES ('${ORG}', '${ALICE}', 'owner');
    INSERT INTO packages (id, type) VALUES ('${AGENT}', 'agent');
    INSERT INTO package_schedules
      (id, package_id, user_id, org_id, space_id, cron_expression, enabled, disabled_reason)
    VALUES
      ('sch_0037_departed', '${AGENT}', '${BOB}', '${ORG}', '${SPACE}', '0 * * * *', false, 'user'),
      ('sch_0037_paused', '${AGENT}', '${ALICE}', '${ORG}', '${SPACE}', '0 * * * *', false, 'user'),
      ('sch_0037_conn', '${AGENT}', '${BOB}', '${ORG}', '${SPACE}', '0 * * * *', false,
       'connection_deleted'),
      ('sch_0037_armed', '${AGENT}', '${BOB}', '${ORG}', '${SPACE}', '0 * * * *', true, NULL);
  `);
}, 300_000);

afterAll(async () => {
  await pg.close();
});

describe("0037 — schedule disabled reason backfill", () => {
  const expected = {
    sch_0037_armed: null,
    sch_0037_conn: "connection_deleted",
    sch_0037_departed: "actor_left_org",
    sch_0037_paused: "user",
  };

  it("relabels only a departed member actor's `user` row", async () => {
    await pg.exec(script);
    expect(await reasons()).toEqual(expected);
  });

  it("is a no-op the second time", async () => {
    await pg.exec(script);
    expect(await reasons()).toEqual(expected);
  });
});
