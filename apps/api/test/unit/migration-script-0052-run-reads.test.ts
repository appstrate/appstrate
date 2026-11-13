// SPDX-License-Identifier: Apache-2.0

/**
 * Drizzle `0103` then `scripts/migration/0052-run-reads.sql` on a private PGlite
 * replayed through `0102` and seeded with the `run_completed` notifications the
 * previous release wrote: `0103` renames them `run_failed`, the script makes
 * every one a read-state row and keeps in the bell only those of a failed or
 * timed-out run. A second run changes nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { journalPGlite } from "../helpers/journal.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const SCRIPT = `${REPO_ROOT}/scripts/migration/0052-run-reads.sql`;
const DRIZZLE = `${REPO_ROOT}/packages/db/drizzle`;
/** A migration's tag, whatever its slug. */
const tagOf = (index: string) =>
  readdirSync(DRIZZLE)
    .filter((f) => f.startsWith(`${index}_`) && f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""))[0]!;

const ORG = "e0000000-0000-4000-8000-00000000d052";
const SPACE = "spc_d0520000-0000-4000-8000-000000000001";
const ALICE = "usr_0052_alice";
const AGENT = "@acme0052/agent";

let pg: PGlite;

const run = (n: number) => `run_0052_${n}`;

async function notificationsByRun(): Promise<Record<string, string>> {
  const { rows } = await pg.query<{ run_id: string; status: string }>(
    `SELECT run_id, payload ->> 'status' AS status FROM notifications
     WHERE type = 'run_failed' ORDER BY run_id`,
  );
  return Object.fromEntries(rows.map((r) => [r.run_id, r.status]));
}

async function reads(): Promise<{ run_id: string; read: boolean }[]> {
  const { rows } = await pg.query<{ run_id: string; read: boolean }>(
    `SELECT run_id, read_at IS NOT NULL AS read FROM run_reads ORDER BY run_id`,
  );
  return rows;
}

beforeAll(async () => {
  pg = await journalPGlite({ through: tagOf("0102") });
  const statuses = ["success", "failed", "timeout", "cancelled"];
  await pg.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('${ORG}', 'Zero52', 'zero-52');
    INSERT INTO spaces (id, org_id, name, is_default) VALUES ('${SPACE}', '${ORG}', 'Default', true);
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('${ALICE}', 'Alice', 'a-0052@example.com', true, now(), now());
    INSERT INTO packages (id, type) VALUES ('${AGENT}', 'agent');
    ${statuses
      .map(
        (s, i) => `INSERT INTO runs (id, package_id, org_id, space_id, user_id, status)
          VALUES ('${run(i)}', '${AGENT}', '${ORG}', '${SPACE}', '${ALICE}', '${s}');
        INSERT INTO notifications (org_id, space_id, recipient_type, recipient_id, type, run_id, payload, read_at)
          VALUES ('${ORG}', '${SPACE}', 'user', '${ALICE}', 'run_completed', '${run(i)}',
            '{"packageId":"${AGENT}","status":"${s}"}'::jsonb, ${i === 0 ? "now()" : "NULL"});`,
      )
      .join("\n")}
    INSERT INTO notifications (org_id, space_id, recipient_type, recipient_id, type, payload)
      VALUES ('${ORG}', '${SPACE}', 'user', '${ALICE}', 'package_shared',
        '{"packageId":"@acme0052/skill","package_type":"skill","shared_by_name":"Bob"}'::jsonb);
  `);
  await pg.exec(await Bun.file(`${DRIZZLE}/${tagOf("0103")}.sql`).text());
});

afterAll(async () => {
  await pg.close();
});

describe("scripts/migration/0052-run-reads.sql", () => {
  it("drizzle 0103 renames the stored run notifications and refuses the old type", async () => {
    const { rows } = await pg.query<{ type: string; n: number }>(
      `SELECT type, count(*)::int AS n FROM notifications GROUP BY type ORDER BY type`,
    );
    expect(rows).toEqual([
      { type: "package_shared", n: 1 },
      { type: "run_failed", n: 4 },
    ]);
    await expect(
      pg.exec(`INSERT INTO notifications (org_id, space_id, recipient_type, recipient_id, type)
        VALUES ('${ORG}', '${SPACE}', 'user', '${ALICE}', 'run_completed')`),
    ).rejects.toThrow(/notifications_type_valid/);
  });

  it("copies every run notification into run_reads, keeping read state", async () => {
    await pg.exec(await Bun.file(SCRIPT).text());
    expect(await reads()).toEqual([
      { run_id: run(0), read: true },
      { run_id: run(1), read: false },
      { run_id: run(2), read: false },
      { run_id: run(3), read: false },
    ]);
  });

  it("keeps only failed and timed-out run notifications, and the other kinds", async () => {
    expect(await notificationsByRun()).toEqual({
      [run(1)]: "failed",
      [run(2)]: "timeout",
    });
    const { rows } = await pg.query(`SELECT 1 FROM notifications WHERE type = 'package_shared'`);
    expect(rows).toHaveLength(1);
  });

  it("changes nothing when run again", async () => {
    const before = JSON.stringify([await reads(), await notificationsByRun()]);
    await pg.exec(await Bun.file(SCRIPT).text());
    expect(JSON.stringify([await reads(), await notificationsByRun()])).toBe(before);
  });
});
