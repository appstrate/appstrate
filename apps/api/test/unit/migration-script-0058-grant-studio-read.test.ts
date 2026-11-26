// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0058-grant-studio-read.sql` on a private PGlite replayed to
 * the head of the journal: every custom space role gains `studio:read` once, and
 * a second run is refused before it writes, so a role narrowed after the first
 * run keeps the Studio withheld.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { journalPGlite } from "../helpers/journal.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const SCRIPT = `${REPO_ROOT}/scripts/migration/0058-grant-studio-read.sql`;

const ORG = "e0000000-0000-4000-8000-00000000d058";
const READER = "srl_d0580000-0000-4000-8000-000000000001";
const RUNNER = "srl_d0580000-0000-4000-8000-000000000002";

let pg: PGlite;

async function permissionsOf(id: string): Promise<string[]> {
  const { rows } = await pg.query<{ permissions: string[] }>(
    `SELECT permissions FROM space_roles WHERE id = $1`,
    [id],
  );
  return rows[0]!.permissions;
}

beforeAll(async () => {
  pg = await journalPGlite();
  await pg.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('${ORG}', 'Studio', 'studio-0058');
    INSERT INTO space_roles (id, org_id, key, name, permissions) VALUES
      ('${READER}', '${ORG}', 'reader', 'Reader', ARRAY['agents:read', 'runs:read']),
      ('${RUNNER}', '${ORG}', 'chat-only', 'Chat only', ARRAY['agents:run']);
  `);
  // A journal replay runs past the 15s default on a cold machine.
}, 300_000);

afterAll(async () => {
  await pg.close();
});

describe("scripts/migration/0058 — custom roles keep the Studio", () => {
  it("appends studio:read to every custom role, then refuses a second run without writing", async () => {
    const results = await pg.exec(await Bun.file(SCRIPT).text());
    // The verification query closing the script reports no custom role left without it.
    const verification = results.filter((r) =>
      r.fields.some((f) => f.name === "custom_roles_without_studio_read"),
    );
    expect(String(verification[0]!.rows[0]!.custom_roles_without_studio_read)).toBe("0");
    expect(await permissionsOf(READER)).toEqual(["agents:read", "runs:read", "studio:read"]);
    expect(await permissionsOf(RUNNER)).toEqual(["agents:run", "studio:read"]);

    // An admin narrows a role after the deploy: a re-run must not grant the Studio back.
    await pg.exec(
      `UPDATE space_roles SET permissions = ARRAY['agents:run'] WHERE id = '${RUNNER}'`,
    );
    let refusal: unknown;
    try {
      await pg.exec(await Bun.file(SCRIPT).text());
    } catch (error) {
      refusal = error;
    }
    expect(String(refusal)).toContain("already hold studio:read");
    await pg.exec("ROLLBACK");
    expect(await permissionsOf(RUNNER)).toEqual(["agents:run"]);
    expect(await permissionsOf(READER)).toEqual(["agents:read", "runs:read", "studio:read"]);
  });
});
