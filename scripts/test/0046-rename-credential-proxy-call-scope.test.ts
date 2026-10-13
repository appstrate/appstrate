// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0046` against the test database: an API key and a custom space role holding
 * `credential-proxy:call` hold `credential-proxy:call-run` in its place after `--apply`, the order
 * and every other element kept; a row holding both names loses the old one; a row holding the new
 * name, `credential-proxy:call-own` or neither is left as it is; a dry run writes nothing; a second
 * `--apply` rewrites nothing.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { db } from "@appstrate/db/client";
import { apiKeys, spaceRoles } from "@appstrate/db/schema";
import { runRenameCredentialProxyCallScope } from "../migration/0046-rename-credential-proxy-call-scope.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../apps/api/test/helpers/auth.ts";
import { seedApiKey, seedSpaceRole } from "../../apps/api/test/helpers/seed.ts";

const OLD = "credential-proxy:call";
const NEW = "credential-proxy:call-run";
const OWN = "credential-proxy:call-own";

/** What each fixture row stores, by its name, and what `--apply` leaves in it. */
const BEFORE: Record<string, string[]> = {
  old: ["agents:run", OLD, "runs:read"],
  both: [NEW, "agents:run", OLD],
  new: ["agents:run", NEW],
  own: [OWN, "agents:run"],
  none: [],
};
const AFTER: Record<string, string[]> = {
  ...BEFORE,
  old: ["agents:run", NEW, "runs:read"],
  both: [NEW, "agents:run"],
};

let ctx: TestContext;
const lines: string[] = [];
const run = (apply: boolean) =>
  runRenameCredentialProxyCallScope({ apply, out: (line) => lines.push(line) });

/** Every key's scopes and every role's permissions, by fixture name. */
async function stored() {
  const keys = await db.select({ name: apiKeys.name, held: apiKeys.scopes }).from(apiKeys);
  const roles = await db
    .select({ name: spaceRoles.key, held: spaceRoles.permissions })
    .from(spaceRoles);
  const byName = (rows: Array<{ name: string; held: string[] }>) =>
    Object.fromEntries(rows.map((row) => [row.name, row.held]));
  return { keys: byName(keys), roles: byName(roles) };
}

describe("0046 — credential-proxy:call renamed credential-proxy:call-run where it is stored", () => {
  beforeEach(async () => {
    await truncateAll();
    lines.length = 0;
    ctx = await createTestContext({ orgSlug: "mig0046" });
  });

  it("a dry run writes nothing; --apply renames in the rows holding the old name; a second --apply rewrites 0", async () => {
    const keys: Record<string, Awaited<ReturnType<typeof seedApiKey>>> = {};
    const roles: Record<string, Awaited<ReturnType<typeof seedSpaceRole>>> = {};
    for (const [name, held] of Object.entries(BEFORE)) {
      keys[name] = await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        name,
        scopes: held,
      });
      roles[name] = await seedSpaceRole({ orgId: ctx.orgId, key: name, permissions: held });
    }
    const rewritten = {
      apiKeyIds: [keys.old!.id, keys.both!.id].sort(),
      roles: [roles.old!, roles.both!]
        .map(({ id, orgId, key }) => ({ id, orgId, key }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };

    expect(await run(false)).toEqual(rewritten);
    expect(lines[0]).toStartWith("database: ");
    expect(lines).toContain(`api_keys.scopes holding ${OLD}: 2`);
    expect(lines).toContain(`space_roles.permissions holding ${OLD}: 2`);
    expect(lines).toContain(`  key ${keys.old!.id}`);
    expect(lines).toContain(`  role ${roles.old!.id} (org ${ctx.orgId}, key old)`);
    expect(lines).toContain(`left holding ${OLD}: 0`);
    expect(lines.at(-1)).toContain("DRY RUN");
    for (const key of Object.values(keys)) {
      expect(lines.join("\n")).not.toContain(key.keyHash);
      expect(lines.join("\n")).not.toContain(key.keyPrefix);
    }
    expect(await stored()).toEqual({ keys: BEFORE, roles: BEFORE });

    lines.length = 0;
    expect(await run(true)).toEqual(rewritten);
    expect(lines.at(-1)).toBe("0046: APPLIED — committed.");
    expect(await stored()).toEqual({ keys: AFTER, roles: AFTER });

    lines.length = 0;
    expect(await run(true)).toEqual({ apiKeyIds: [], roles: [] });
    expect(lines).toContain(`api_keys.scopes holding ${OLD}: 0`);
    expect(lines).toContain(`space_roles.permissions holding ${OLD}: 0`);
    expect(await stored()).toEqual({ keys: AFTER, roles: AFTER });
  });
});
