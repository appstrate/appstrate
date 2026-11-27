// SPDX-License-Identifier: Apache-2.0

/** Script `0060` against the test database: the preset default role moves from `org_settings` to its column. */

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { organizations } from "@appstrate/db/schema";
import { runPersonalSpacePresetRole } from "../migration/0060-personal-space-preset-role.ts";
import {
  assertNoPendingDataScripts,
  PENDING_DATA_SCRIPTS,
} from "../../apps/api/src/lib/boot-guards/pending-data-scripts.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../apps/api/test/helpers/auth.ts";

const ENTRY = PENDING_DATA_SCRIPTS.find((e) => e.after === "0118")!;
const lines: string[] = [];
const run = (apply: boolean) =>
  runPersonalSpacePresetRole({ apply, out: (line) => lines.push(line) });
const pending = async () => {
  const err = await assertNoPendingDataScripts(null, [ENTRY]).then(
    () => null,
    (e: Error) => e,
  );
  return err === null ? 0 : Number(/: (\d+) pending/.exec(err.message)![1]);
};
const rowOf = async (ctx: TestContext) =>
  (await db.select().from(organizations).where(eq(organizations.id, ctx.orgId)))[0]!;

describe("0060 — the personal-space preset role leaves org_settings", () => {
  let viewer: TestContext;
  let untouched: TestContext;

  beforeEach(async () => {
    await truncateAll();
    lines.length = 0;
    viewer = await createTestContext({ orgSlug: "mig0060-viewer" });
    untouched = await createTestContext({ orgSlug: "mig0060-none" });
    await db
      .update(organizations)
      .set({ orgSettings: { personal_space_role: "viewer", dashboard_sso_enabled: true } })
      .where(eq(organizations.id, viewer.orgId));
  });

  it("a dry run writes nothing", async () => {
    expect(await pending()).toBe(1);
    const dry = await run(false);
    expect(lines.at(-1)).toContain("DRY RUN");
    expect(dry.moved).toHaveLength(1);
    expect((await rowOf(viewer)).orgSettings).toHaveProperty("personal_space_role", "viewer");
    expect((await rowOf(viewer)).personalSpacePresetRole).toBeNull();
    expect(await pending()).toBe(1);
  });

  it("--apply copies the preset, removes the key, keeps other keys", async () => {
    await run(true);
    expect(lines.at(-1)).toBe("0060: APPLIED — committed.");
    const v = await rowOf(viewer);
    expect(v.personalSpacePresetRole).toBe("viewer");
    expect(v.orgSettings).toEqual({ dashboard_sso_enabled: true });
    expect((await rowOf(untouched)).personalSpacePresetRole).toBeNull();
    expect(await pending()).toBe(0);
  });

  it("a second --apply writes nothing", async () => {
    await run(true);
    const again = await run(true);
    expect(again.moved).toEqual([]);
    expect(await pending()).toBe(0);
  });
});
