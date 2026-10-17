// SPDX-License-Identifier: Apache-2.0

/**
 * Boot refusal while `package_shares` holds a row — i.e. while
 * `scripts/migration/0046-fold-package-shares.ts` has not run on a database migrated past drizzle
 * `0099`. A database with nothing to fold boots, a database holding a share refuses with the
 * operator command for its tier, and the same database boots once `0046 --apply` has emptied the
 * table — a share it skips included, and after a placement is revoked. On an embedded database the command it names is run through the
 * script's entry point. See docs/NO_TRANSITIONAL_CODE.md §4 — this check must never repair.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { db, getPGliteClient } from "@appstrate/db/client";
import { packageShares } from "@appstrate/db/schema";
import {
  assertPackageSharesFolded,
  unfoldedPackageShareCount,
} from "../../apps/api/src/lib/boot.ts";
import { runFoldPackageShares } from "../migration/0046-fold-package-shares.ts";
import { revokePackageShare } from "../../apps/api/src/services/package-shares.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../apps/api/test/helpers/auth.ts";
import { seedPackage, seedSpace } from "../../apps/api/test/helpers/seed.ts";

const AGENT = "@gate0046/agent";
const SCRIPT = new URL("../migration/0046-fold-package-shares.ts", import.meta.url).pathname;
const COMMAND = /bun scripts\/migration\/0046-fold-package-shares\.ts --apply/;

let ctx: TestContext;

const share = (spaceId: string) =>
  db.insert(packageShares).values({ packageId: AGENT, spaceId, sharedBy: ctx.user.id });
const apply0046 = () => runFoldPackageShares({ apply: true, out: () => {} });
const guard = () => assertPackageSharesFolded(null);

describe("assertPackageSharesFolded — injected count", () => {
  it("returns once the table is empty", async () => {
    expect(await assertPackageSharesFolded(null, async () => 0)).toBeUndefined();
  });

  it("refuses to boot, naming the count and the operator command", async () => {
    await expect(assertPackageSharesFolded(null, async () => 3)).rejects.toThrow(
      /package_shares still holds 3 row\(s\)[\s\S]*Refusing to boot[\s\S]*0046-fold-package-shares\.ts --apply`, with this DATABASE_URL/,
    );
  });

  it("names the embedded database's directory on an embedded database", async () => {
    await expect(
      assertPackageSharesFolded("/srv/appstrate/data/pglite", async () => 1),
    ).rejects.toThrow(
      "`PGLITE_DATA_DIR=/srv/appstrate/data/pglite bun scripts/migration/0046-fold-package-shares.ts` (dry run), then the same with `--apply`",
    );
  });

  it("propagates a failing probe instead of assuming the fold ran", async () => {
    const boom = new Error("connection terminated");
    await expect(assertPackageSharesFolded(null, () => Promise.reject(boom))).rejects.toThrow(boom);
  });
});

describe("assertPackageSharesFolded — live database", () => {
  const dirs: string[] = [];
  const tempDir = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
  let team: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "gate0046" });
    const home = (await seedSpace({ orgId: ctx.orgId, name: "Home" })).id;
    team = (await seedSpace({ orgId: ctx.orgId, name: "Team" })).id;
    await seedPackage({ id: AGENT, orgId: ctx.orgId, type: "agent", homeSpaceId: home });
  });

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("boots a database holding no share", async () => {
    expect(await guard()).toBeUndefined();
  });

  it("refuses while a share has no row, and boots once 0046 --apply has folded it", async () => {
    await share(team);
    await expect(guard()).rejects.toThrow(COMMAND);

    await runFoldPackageShares({ apply: false, out: () => {} });
    await expect(guard()).rejects.toThrow(/package_shares still holds 1 row\(s\)/);

    expect((await apply0046()).inserted).toBe(1);
    expect(await guard()).toBeUndefined();
  });

  it("still boots after the folded placement is revoked", async () => {
    // No code writes `package_shares` any more, so the row a revoke deletes is
    // the `space_packages` one alone: the emptied table must stay empty.
    await share(team);
    await apply0046();
    expect(
      await revokePackageShare({
        packageId: AGENT,
        spaceId: team,
        orgId: ctx.orgId,
        authorizeHome: () => true,
      }),
    ).toBe(true);
    expect(await guard()).toBeUndefined();
  });

  it("boots after 0046 --apply when the only share names a space 0046 skips", async () => {
    const stranger = await createTestContext({ orgSlug: "gate0046-other" });
    await share(stranger.defaultSpaceId);
    await expect(guard()).rejects.toThrow(COMMAND);

    const fold = await apply0046();
    expect(fold.inserted).toBe(0);
    expect(fold.skipped).toHaveLength(1);
    expect(await guard()).toBeUndefined();
  });

  // The suite's own database must be an embedded one to be copied into a directory of its own.
  it.skipIf(getPGliteClient() === null)(
    "on an embedded database, the command the refusal names lifts it through the script's entry point",
    async () => {
      await share(team);
      const dataDir = tempDir("pglite-0046-");
      const seeded = new PGlite(dataDir, { loadDataDir: await getPGliteClient()!.dumpDataDir() });
      await expect(
        assertPackageSharesFolded(dataDir, () => unfoldedPackageShareCount(drizzle(seeded))),
      ).rejects.toThrow(
        `PGLITE_DATA_DIR=${dataDir} bun scripts/migration/0046-fold-package-shares.ts`,
      );
      await seeded.close();

      // A directory with no `.env`, so Bun loads none into the script.
      const cwd = tempDir("cwd-0046-");
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) => k !== "DATABASE_URL" && k !== "PGLITE_DATA_DIR",
        ),
      );
      const implicit = Bun.spawnSync(["bun", SCRIPT, "--apply"], { cwd, env });
      expect(implicit.exitCode).toBe(2);
      expect(implicit.stdout.toString()).toContain(
        "neither DATABASE_URL nor PGLITE_DATA_DIR is set",
      );

      const named = Bun.spawnSync(["bun", SCRIPT, "--apply"], {
        cwd,
        env: { ...env, PGLITE_DATA_DIR: dataDir },
      });
      expect(named.stdout.toString()).toContain("0046: APPLIED — committed.");
      expect(named.exitCode).toBe(0);

      const migrated = new PGlite(dataDir);
      try {
        expect(
          await assertPackageSharesFolded(dataDir, () =>
            unfoldedPackageShareCount(drizzle(migrated)),
          ),
        ).toBeUndefined();
      } finally {
        await migrated.close();
      }
    },
    60_000,
  );
});
