// SPDX-License-Identifier: Apache-2.0

/**
 * Boot refusal while `integration_connections.shared_space_ids` still holds shares — i.e. while
 * `scripts/migration/0044-connection-shares.ts` has not run on a database migrated past drizzle
 * `0089`. A fresh database boots, a database holding the column refuses with the operator command
 * for its tier, and the same database boots once `0044 --apply` has run, a skipped target space
 * included. On an embedded database the command it names is run through the script's entry point.
 * See docs/NO_TRANSITIONAL_CODE.md §5 — this check must never repair.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { db, getPGliteClient } from "@appstrate/db/client";
import { integrationConnections } from "@appstrate/db/schema";
import {
  assertConnectionSharesCopied,
  uncopiedShareConnectionCount,
} from "../../apps/api/src/lib/boot.ts";
import { runConnectionShares } from "../migration/0044-connection-shares.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../apps/api/test/helpers/auth.ts";
import { seedPackage } from "../../apps/api/test/helpers/seed.ts";

const INTEGRATION = "@gate0044/svc";
const script = (name: string) => new URL(`../migration/${name}.ts`, import.meta.url).pathname;
const SCRIPT = script("0044-connection-shares");
/** The scripts an operator runs around the beta.67 window, each refusing an unnamed database. */
const WINDOW_SCRIPTS = [
  "0040-token-usage-shape",
  "0041-widen-connections-to-org-scope",
  "0043-promote-auto-clients-to-org",
  "0044-connection-shares",
  "0045-pin-connection-made-in-space",
];
const COMMAND = /bun scripts\/migration\/0044-connection-shares\.ts --apply/;

let ctx: TestContext;

async function seedConnection(sharedSpaceIds: string[]): Promise<void> {
  await db.insert(integrationConnections).values({
    integrationId: INTEGRATION,
    authKey: "primary",
    accountId: `acct-${crypto.randomUUID().slice(0, 8)}`,
    orgId: ctx.orgId,
    spaceId: null,
    userId: ctx.user.id,
    credentialsEncrypted: "x",
    label: `Connexion ${crypto.randomUUID().slice(0, 8)}`,
    sharedSpaceIds,
  });
}

const apply0044 = () => runConnectionShares({ apply: true, out: () => {} });
const guard = () => assertConnectionSharesCopied(null);

describe("assertConnectionSharesCopied — injected count", () => {
  it("returns once no connection holds a share in the column", async () => {
    expect(await assertConnectionSharesCopied(null, async () => 0)).toBeUndefined();
  });

  it("refuses to boot, naming the count and the operator command", async () => {
    await expect(assertConnectionSharesCopied(null, async () => 3)).rejects.toThrow(
      /3 connection\(s\)[\s\S]*Refusing to boot[\s\S]*0044-connection-shares\.ts --apply`, with this DATABASE_URL/,
    );
  });

  it("names the embedded database's directory on an embedded database", async () => {
    await expect(
      assertConnectionSharesCopied("/srv/appstrate/data/pglite", async () => 1),
    ).rejects.toThrow(
      "`PGLITE_DATA_DIR=/srv/appstrate/data/pglite bun scripts/migration/0044-connection-shares.ts` (dry run), then the same with `--apply`",
    );
  });

  it("propagates a failing probe instead of assuming the copy ran", async () => {
    const boom = new Error("connection terminated");
    await expect(assertConnectionSharesCopied(null, () => Promise.reject(boom))).rejects.toThrow(
      boom,
    );
  });
});

describe("assertConnectionSharesCopied — live database", () => {
  const dirs: string[] = [];
  const tempDir = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "gate0044" });
    await seedPackage({ id: INTEGRATION, orgId: ctx.orgId, type: "integration" });
  });

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("boots a database whose connections hold no share in the column", async () => {
    await seedConnection([]);
    expect(await guard()).toBeUndefined();
  });

  it("refuses while a share sits in the column, and boots once 0044 --apply has copied it", async () => {
    await seedConnection([ctx.defaultSpaceId]);
    await expect(guard()).rejects.toThrow(COMMAND);

    await runConnectionShares({ apply: false, out: () => {} });
    await expect(guard()).rejects.toThrow(/1 connection\(s\)/);

    expect((await apply0044()).inserted).toBe(1);
    expect(await guard()).toBeUndefined();
  });

  it("boots after 0044 --apply when the only entry names a space 0044 skips", async () => {
    await seedConnection([`spc_${crypto.randomUUID()}`]);
    await expect(guard()).rejects.toThrow(COMMAND);

    const copy = await apply0044();
    expect(copy.inserted).toBe(0);
    expect(copy.skipped).toHaveLength(1);
    expect(await guard()).toBeUndefined();
  });

  // The suite's own database must be an embedded one to be copied into a directory of its own.
  it.skipIf(getPGliteClient() === null)(
    "on an embedded database, the command the refusal names lifts it through the script's entry point, and 0040 runs there",
    async () => {
      await seedConnection([ctx.defaultSpaceId]);
      const dataDir = tempDir("pglite-0044-");
      const seeded = new PGlite(dataDir, { loadDataDir: await getPGliteClient()!.dumpDataDir() });
      await expect(
        assertConnectionSharesCopied(dataDir, () => uncopiedShareConnectionCount(drizzle(seeded))),
      ).rejects.toThrow(
        `PGLITE_DATA_DIR=${dataDir} bun scripts/migration/0044-connection-shares.ts`,
      );
      await seeded.close();

      // A directory with no `.env`, so Bun loads none into the script.
      const cwd = tempDir("cwd-0044-");
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) => k !== "DATABASE_URL" && k !== "PGLITE_DATA_DIR",
        ),
      );
      for (const name of WINDOW_SCRIPTS) {
        const implicit = Bun.spawnSync(["bun", script(name), "--apply"], { cwd, env });
        expect(implicit.exitCode).not.toBe(0);
        expect(implicit.stdout.toString()).toContain(
          "neither DATABASE_URL nor PGLITE_DATA_DIR is set",
        );
      }

      const named = Bun.spawnSync(["bun", SCRIPT, "--apply"], {
        cwd,
        env: { ...env, PGLITE_DATA_DIR: dataDir },
      });
      expect(named.stdout.toString()).toContain("0044: APPLIED — committed.");
      expect(named.exitCode).toBe(0);
      const usage = Bun.spawnSync(["bun", script("0040-token-usage-shape")], {
        cwd,
        env: { ...env, PGLITE_DATA_DIR: dataDir },
      });
      expect(usage.stdout.toString()).toContain("0040: DRY RUN");
      expect(usage.exitCode).toBe(0);

      const migrated = new PGlite(dataDir);
      try {
        expect(
          await assertConnectionSharesCopied(dataDir, () =>
            uncopiedShareConnectionCount(drizzle(migrated)),
          ),
        ).toBeUndefined();
      } finally {
        await migrated.close();
      }
    },
    60_000,
  );
});
