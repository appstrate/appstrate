// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0036-resolved-connection-labels.sql` on a private PGlite
 * replayed to `0076` — where the runbook runs it, before `0077` names the
 * unlabelled connections: every legacy snapshot element ends with a non-empty
 * `label` and a string `accountId` — the one shape `resolvedConnectionMapSchema`
 * reads back — a rerun is a no-op, an element whose connection is gone and that
 * names no account is still filled, and one without a `connectionId` refuses the batch.
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
const BLANK = "d0360000-0000-4000-8000-000000000003";
const UNNAMED = "d0360000-0000-4000-8000-000000000004";
/** An API-key connection: `account_id` is the placeholder `default`, never a name. */
const KEYED = "d0360000-0000-4000-8000-000000000005";

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
  await replayJournal(pg, "0076_space_packages_chat_enforced");
  await pg.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('${ORG}', 'Zero36', 'zero-36');
    INSERT INTO spaces (id, org_id, name, is_default) VALUES ('${SPACE}', '${ORG}', 'Default', true);
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('${ALICE}', 'Alice', 'a-0036@example.com', true, now(), now());
    INSERT INTO packages (id, type) VALUES ('${AGENT}', 'agent'), ('${GMAIL}', 'integration');
    INSERT INTO integration_connections
      (id, integration_package_id, auth_key, account_id, space_id, user_id, credentials_encrypted, label)
      VALUES ('${LIVE}', '${GMAIL}', 'primary', 'alice@acme.test', '${SPACE}', '${ALICE}', 'x', 'Boulot'),
             ('${BLANK}', '${GMAIL}', 'primary', 'blank@acme.test', '${SPACE}', '${ALICE}', 'x', ''),
             ('${UNNAMED}', '${GMAIL}', 'primary', 'unnamed@acme.test', '${SPACE}', '${ALICE}', 'x', NULL),
             ('${KEYED}', '${GMAIL}', 'key', 'default', '${SPACE}', '${ALICE}', 'x', NULL);
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
      { connectionId: LIVE, source: "run_override", label: "", accountId: "alice@acme.test" },
      { connectionId: BLANK, source: "run_override", label: null, accountId: "was@acme.test" },
      { connectionId: UNNAMED, source: "run_override", label: null },
      { connectionId: KEYED, source: "run_override", label: null, accountId: "default" },
    ],
  });
}, 300_000);

afterAll(async () => {
  await pg.close();
});

describe("0036 — resolved connection labels", () => {
  it("fills every short element from its connection's label, else its account, and keeps the rest", async () => {
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
        {
          connectionId: LIVE,
          source: "run_override",
          label: "Boulot",
          accountId: "alice@acme.test",
        },
        // The connection's label is '' and its account wins over the element's.
        {
          connectionId: BLANK,
          source: "run_override",
          label: "blank@acme.test",
          accountId: "was@acme.test",
        },
        {
          connectionId: UNNAMED,
          source: "run_override",
          label: "unnamed@acme.test",
          accountId: "unnamed@acme.test",
        },
        // The placeholder account names nothing: the label falls through to the id.
        { connectionId: KEYED, source: "run_override", label: KEYED, accountId: "default" },
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

  it("names an element with a deleted connection and no or an empty account by its connectionId", async () => {
    await insertRun("run_0036_orphan", {
      [GMAIL]: [
        { connectionId: GONE, source: "fallback_auto", label: null },
        { connectionId: GONE, source: "fallback_auto", label: null, accountId: "" },
      ],
    });
    await pg.exec(script);
    const named = { connectionId: GONE, source: "fallback_auto", label: GONE, accountId: "" };
    expect(await snapshot("run_0036_orphan")).toEqual({ [GMAIL]: [named, named] });
    resolvedConnectionMapSchema.parse(await snapshot("run_0036_orphan"));
  });

  it("refuses the batch when an element carries no connectionId", async () => {
    const corrupt = { [GMAIL]: [{ source: "fallback_auto", label: null }] };
    await insertRun("run_0036_no_id", corrupt);
    await insertRun("run_0036_pending", {
      [GMAIL]: [{ connectionId: LIVE, source: "member_pin", label: null }],
    });
    await expect(pg.exec(script)).rejects.toThrow(/0036: 1 snapshot element\(s\) carry no string/);
    await pg.exec("ROLLBACK");
    expect(await snapshot("run_0036_no_id")).toEqual(corrupt);
    expect(await snapshot("run_0036_pending")).toEqual({
      [GMAIL]: [{ connectionId: LIVE, source: "member_pin", label: null }],
    });
  });
});
