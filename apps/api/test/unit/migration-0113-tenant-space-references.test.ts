// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { journalPGlite } from "../helpers/journal.ts";

it("checks existing and future tenant references, including organization-wide grants", async () => {
  const pg = await journalPGlite({ through: "0112_chat_skill_pins" });
  const migration = await Bun.file(
    new URL("../../../../packages/db/drizzle/0113_tenant_space_references.sql", import.meta.url),
  ).text();
  const org = "01130000-0000-4000-a000-000000000001";
  const other = "01130000-0000-4000-a000-000000000002";
  try {
    await pg.exec(`
      INSERT INTO organizations (id,name,slug) VALUES ('${org}','Fixtures','fixtures'), ('${other}','Other','other');
      INSERT INTO spaces (id,org_id,name,is_default) VALUES ('space_a','${org}','One',true), ('space_b','${other}','Two',true);
      INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at) VALUES ('member','Member','audit@example.test',true,now(),now());
      INSERT INTO packages (id,type) VALUES ('@audit/agent','agent');
      INSERT INTO runs (id,package_id,org_id,space_id,user_id,status) VALUES ('run_a','@audit/agent','${org}','space_a','member','success');
      INSERT INTO run_reads (run_id,org_id,space_id,recipient_type,recipient_id) VALUES ('run_a','${org}','space_b','user','member');
      INSERT INTO oauth_clients (id,client_id,redirect_uris) VALUES ('client','client','{}');
      INSERT INTO oauth_grant_states (user_id,client_id,resource,org_id) VALUES ('member','client','org','${org}');
      INSERT INTO oauth_grant_states (user_id,client_id,resource,org_id,space_id) VALUES ('member','client','space','${org}','space_a');
    `);
    await expect(pg.exec(migration)).rejects.toMatchObject({ code: "23503" });
    await pg.exec("UPDATE run_reads SET space_id = 'space_a'");
    await pg.exec(migration);
    for (const table of ["run_reads", "oauth_grant_states"]) {
      await expect(
        pg.exec(`UPDATE ${table} SET space_id = 'space_b' WHERE space_id = 'space_a'`),
      ).rejects.toMatchObject({ code: "23503" });
    }
    expect(
      (await pg.query("SELECT resource FROM oauth_grant_states WHERE space_id IS NULL")).rows,
    ).toEqual([{ resource: "org" }]);
  } finally {
    await pg.close();
  }
});
