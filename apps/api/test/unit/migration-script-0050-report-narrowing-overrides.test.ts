// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0050-report-narrowing-overrides.ts` on a private PGlite replayed to the
 * current schema: the queries it reads, then the report it prints. Each fixture is one clause of
 * the predicate — deleting it moves a schedule in or out of the list.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { journalPGlite } from "../helpers/journal.ts";
import {
  readSnapshot,
  report,
  type ReportSnapshot,
} from "../../../../scripts/migration/0050-report-narrowing-overrides.ts";

const ORG = "e0000000-0000-4000-8000-00000000d048";
const SPACE = "spc_d0480000-0000-4000-8000-000000000001";
const OTHER_SPACE = "spc_d0480000-0000-4000-8000-000000000002";
const USER = "usr_0050";
const AGENT = "@acme/agent-0050";
const PINNED = "@acme/pinned";
const ENFORCED = "@acme/enforced";
const BOTH = "@acme/both";
const SOFT = "@acme/soft";
const FREE = "@acme/free";
const NONE_PINNED = "@acme/none-pinned";

const conn = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, C, D] = [conn(1), conn(2), conn(3), conn(4)];
const json = (v: unknown) => `'${JSON.stringify(v)}'`;

describe("0050 — overrides that narrowed an imposed set", () => {
  let pg: PGlite;
  let snapshot: ReportSnapshot;

  beforeAll(async () => {
    pg = await journalPGlite();
    const integrations = [PINNED, ENFORCED, BOTH, SOFT, FREE, NONE_PINNED];
    await pg.exec(`
      INSERT INTO packages (id, type, source, draft_manifest)
        VALUES ('${AGENT}', 'agent', 'local', '{}'),
               ${integrations.map((i) => `('${i}', 'integration', 'local', '{}')`).join(",")};
      INSERT INTO organizations (id, name, slug) VALUES ('${ORG}', 'Zero48', 'zero-48');
      INSERT INTO spaces (id, org_id, name, is_default)
        VALUES ('${SPACE}', '${ORG}', 'Default', true), ('${OTHER_SPACE}', '${ORG}', 'Other', false);
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
        VALUES ('${USER}', 'Owner', 'o-0050@example.com', true, now(), now());

      -- admin pin {A,B}; member pin on PINNED must govern nothing
      INSERT INTO integration_pins (space_id, package_id, integration_package_id, user_id, connection_ids)
        VALUES ('${SPACE}', '${AGENT}', '${PINNED}', NULL, '{${A},${B}}'),
               ('${SPACE}', '${AGENT}', '${PINNED}', '${USER}', '{${A},${B},${C}}'),
               ('${SPACE}', '${AGENT}', '${BOTH}', NULL, '{${A},${B}}'),
               ('${SPACE}', '${AGENT}', '${NONE_PINNED}', NULL, '{}');
      -- BOTH: the admin pin outranks the enforced default; SOFT: a soft default imposes nothing
      INSERT INTO integration_org_defaults (space_id, integration_package_id, connection_ids, enforce)
        VALUES ('${SPACE}', '${ENFORCED}', '{${A},${B},${C}}', true),
               ('${SPACE}', '${BOTH}', '{${C},${D}}', true),
               ('${SPACE}', '${SOFT}', '{${A},${B}}', false),
               ('${OTHER_SPACE}', '${FREE}', '{${A},${B}}', true);

      INSERT INTO package_schedules
        (id, package_id, user_id, org_id, space_id, name, cron_expression, enabled, connection_overrides)
      VALUES
        -- a strict subset of the admin pin, ids in upper case: widens
        ('sch_subset', '${AGENT}', '${USER}', '${ORG}', '${SPACE}', 'Subset', '0 * * * *', true,
         ${json({ [PINNED]: [A.toUpperCase()] })}),
        -- the empty set under the admin pin, disabled: widens all the same
        ('sch_empty', '${AGENT}', '${USER}', '${ORG}', '${SPACE}', NULL, '0 * * * *', false,
         ${json({ [PINNED]: [] })}),
        -- the whole pin, in another order and with a duplicate: not a narrowing
        ('sch_same', '${AGENT}', '${USER}', '${ORG}', '${SPACE}', 'Same', '0 * * * *', true,
         ${json({ [PINNED]: [B, A, B] })}),
        -- a member of the pin plus an id outside it: outranked, never a narrowing
        ('sch_outside', '${AGENT}', '${USER}', '${ORG}', '${SPACE}', 'Outside', '0 * * * *', true,
         ${json({ [PINNED]: [A, D] })}),
        -- an enforced org default with no pin: widens
        ('sch_enforced', '${AGENT}', '${USER}', '${ORG}', '${SPACE}', 'Enforced', '0 * * * *', true,
         ${json({ [ENFORCED]: [C, A] })}),
        -- the pin wins over the enforced default naming other ids: the layer reported is the pin
        ('sch_both', '${AGENT}', '${USER}', '${ORG}', '${SPACE}', 'Both', '0 * * * *', true,
         ${json({ [BOTH]: [B] })}),
        -- a soft default, an enforced default of ANOTHER space, a pin to nothing: none imposes a set
        ('sch_soft', '${AGENT}', '${USER}', '${ORG}', '${SPACE}', 'Soft', '0 * * * *', true,
         ${json({ [SOFT]: [A], [FREE]: [A], [NONE_PINNED]: [] })}),
        -- one narrowing entry among entries that are not
        ('sch_mixed', '${AGENT}', '${USER}', '${ORG}', '${SPACE}', 'Mixed', '0 * * * *', true,
         ${json({ [SOFT]: [A], [ENFORCED]: [A, B] })}),
        -- malformed: a scalar entry, a JSON null and an array at the root are skipped, not fatal
        ('sch_scalar', '${AGENT}', '${USER}', '${ORG}', '${SPACE}', 'Scalar', '0 * * * *', true,
         ${json({ [PINNED]: A })}),
        ('sch_null', '${AGENT}', '${USER}', '${ORG}', '${SPACE}', 'Null', '0 * * * *', true, 'null'),
        ('sch_array', '${AGENT}', '${USER}', '${ORG}', '${SPACE}', 'Array', '0 * * * *', true, '[]'),
        ('sch_nothing', '${AGENT}', '${USER}', '${ORG}', '${SPACE}', 'Nothing', '0 * * * *', true, NULL);
    `);
    snapshot = await readSnapshot(async (query) => (await pg.query(query)).rows);
  }, 300_000);

  afterAll(async () => {
    await pg.close();
  });

  it("lists the schedules whose override is [] or a strict subset of the imposed set", () => {
    expect(
      snapshot.schedules.map((s) => [
        s.id,
        s.enabled,
        s.integration,
        s.override_set,
        s.imposed_set,
        s.imposed_by,
      ]),
    ).toEqual([
      ["sch_both", true, BOTH, `[${B}]`, `[${A}, ${B}]`, "admin pin"],
      ["sch_empty", false, PINNED, "[]", `[${A}, ${B}]`, "admin pin"],
      [
        "sch_enforced",
        true,
        ENFORCED,
        `[${A}, ${C}]`,
        `[${A}, ${B}, ${C}]`,
        "enforced org default",
      ],
      ["sch_mixed", true, ENFORCED, `[${A}, ${B}]`, `[${A}, ${B}, ${C}]`, "enforced org default"],
      ["sch_subset", true, PINNED, `[${A}]`, `[${A}, ${B}]`, "admin pin"],
    ]);
    expect(snapshot.schedules[0]).toMatchObject({
      org: "zero-48",
      space: "Default",
      name: "Both",
      package_id: AGENT,
    });
  });

  it("prints the totals, enabled and disabled", () => {
    const lines = report(snapshot);
    expect(lines.at(-1)).toBe(
      "5 schedule(s) widen at their next fire: 4 enabled, 1 disabled (5 integration entries).",
    );
    expect(lines.join("\n")).toContain("sch_subset");
  });

  it("says nothing widens when no schedule does", () => {
    expect(report({ schedules: [] })[0]).toBe("0 schedules — nothing widens.");
  });
});
