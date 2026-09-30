// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0036-resolved-connection-labels.sql` on a private PGlite
 * replayed to the current schema: every legacy snapshot element ends with a
 * string `label` and `accountId` — the one shape `resolvedConnectionMapSchema`
 * reads back — a rerun is a no-op, and an element with nothing to take refuses
 * the whole batch.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { resolvedConnectionMapSchema } from "@appstrate/core/integration";
import { replayJournal } from "../helpers/journal.ts";

const SCRIPT = resolve(
  import.meta.dir,
  "../../../../scripts/migration/0036-resolved-connection-labels.sql",
);

const ORG = "e0000000-0000-4000-8000-00000000d036";
const SPACE = "spc_d0360000-0000-4000-8000-000000000001";
const ALICE = "usr_0036_alice";
const AGENT = "@acme0036/agent";
const GMAIL = "@acme0036/gmail";
const LIVE = "d0360000-0000-4000-8000-000000000001";
const GONE = "d0360000-0000-4000-8000-000000000002";

const pg = new PGlite();
const script = await Bun.file(SCRIPT).text();

async function insertRun(id: string, resolved: Record<string, unknown>): Promise<void> {
  await pg.query(
    `INSERT INTO runs (id, package_id, user_id, space_id, org_id, status, started_at, resolved_connections)
     VALUES ($1, $2, $3, $4, $5, 'success', now(), $6)`,
    [id, AGENT, ALICE, SPACE, ORG, JSON.stringify(resolved)],
  );
}

async function snapshot(id: string): Promise<unknown> {
  const { rows } = await pg.query<{ resolved_connections: unknown }>(
    "SELECT resolved_connections FROM runs WHERE id = $1",
    [id],
  );
  return rows[0]!.resolved_connections;
}

beforeAll(async () => {
  await replayJournal(pg);
  await pg.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('${ORG}', 'Zero36', 'zero-36');
    INSERT INTO spaces (id, org_id, name, is_default) VALUES ('${SPACE}', '${ORG}', 'Default', true);
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('${ALICE}', 'Alice', 'a-0036@example.com', true, now(), now());
    INSERT INTO packages (id, type) VALUES ('${AGENT}', 'agent'), ('${GMAIL}', 'integration');
    INSERT INTO integration_connections
      (id, integration_package_id, auth_key, account_id, space_id, user_id, credentials_encrypted, label)
      VALUES ('${LIVE}', '${GMAIL}', 'primary', 'alice@acme.test', '${SPACE}', '${ALICE}', 'x', 'Boulot');
  `);
  await insertRun("run_0036_current", {
    [GMAIL]: [
      { connectionId: LIVE, source: "member_pin", label: "Kept", accountId: "k@acme.test" },
    ],
  });
  await insertRun("run_0036_legacy", {
    [GMAIL]: [
      { connectionId: LIVE, source: "run_override", label: null, accountId: "alice@acme.test" },
      { connectionId: GONE, source: "run_override", label: null, accountId: "gone@acme.test" },
      { connectionId: LIVE, source: "run_override" },
    ],
  });
}, 300_000);

afterAll(async () => {
  await pg.close();
});

describe("0036 — resolved connection labels", () => {
  it("fills every short element from its connection, else its account, and keeps the rest", async () => {
    await pg.exec(script);

    expect(await snapshot("run_0036_legacy")).toEqual({
      [GMAIL]: [
        {
          connectionId: LIVE,
          source: "run_override",
          label: "Boulot",
          accountId: "alice@acme.test",
        },
        {
          connectionId: GONE,
          source: "run_override",
          label: "gone@acme.test",
          accountId: "gone@acme.test",
        },
        {
          connectionId: LIVE,
          source: "run_override",
          label: "Boulot",
          accountId: "alice@acme.test",
        },
      ],
    });
    expect(await snapshot("run_0036_current")).toEqual({
      [GMAIL]: [
        { connectionId: LIVE, source: "member_pin", label: "Kept", accountId: "k@acme.test" },
      ],
    });
    // The read seam now accepts both rows.
    for (const id of ["run_0036_legacy", "run_0036_current"]) {
      resolvedConnectionMapSchema.parse(await snapshot(id));
    }
  });

  it("is a no-op the second time", async () => {
    const before = await snapshot("run_0036_legacy");
    await pg.exec(script);
    expect(await snapshot("run_0036_legacy")).toEqual(before);
  });

  it("refuses the batch when an element has nothing to take", async () => {
    await insertRun("run_0036_orphan", {
      [GMAIL]: [{ connectionId: GONE, source: "fallback_auto", label: null }],
    });
    await expect(pg.exec(script)).rejects.toThrow(/0036: 1 snapshot element/);
    await pg.exec("ROLLBACK");
    expect(await snapshot("run_0036_orphan")).toEqual({
      [GMAIL]: [{ connectionId: GONE, source: "fallback_auto", label: null }],
    });
  });
});
