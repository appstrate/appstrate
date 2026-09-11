// SPDX-License-Identifier: Apache-2.0

/**
 * `listInstalledPackageHints` (through `listRunnableAgents` /
 * `listInstalledSkills`) is bounded IN SQL: the per-space enabled filter and
 * the cap sit in the query, and `total` is a window count over the filtered
 * set. It runs twice on every chat turn's TTFT path, so it must not load the
 * whole catalog to keep `limit` rows of it.
 *
 * What the SQL rewrite could get wrong, and what is pinned against it:
 *   - `total` counted AFTER the cap (a plain `LIMIT` with `rows.length`) would
 *     report the page size, not the catalog size → `total` is asserted above
 *     `items.length` with `truncated` true;
 *   - the enabled filter applied to the page but not the count → a disabled
 *     install is asserted absent from `total` as well as from `items`;
 *   - a different total order than `listAccessiblePackages` (system first,
 *     then id — load-bearing for the prompt cache) → the page's ids are
 *     asserted in that order, with a system package seeded to lead it.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { listRunnableAgents, listInstalledSkills } from "../../../src/services/space-packages.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedInstalledPackage } from "../../helpers/seed.ts";
import type { SpaceScope } from "../../../src/lib/scope.ts";

describe("listInstalledPackageHints — bounded in SQL", () => {
  let ctx: TestContext;
  let scope: SpaceScope;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "hintorg" });
    scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
  });

  async function seedInstalledAgent(id: string, overrides?: { enabled?: boolean }): Promise<void> {
    await seedPackage({
      id,
      orgId: ctx.orgId,
      draftManifest: {
        name: id,
        version: "0.1.0",
        type: "agent",
        display_name: id.split("/")[1],
        description: "An agent.",
      },
    });
    await seedInstalledPackage(ctx.defaultSpaceId, id, overrides);
  }

  it("caps the page, counts the whole enabled catalog, and keeps the system-first order", async () => {
    // Five enabled local installs, ids chosen so the id tie-break is known.
    for (const n of ["a1", "a2", "a3", "a4", "a5"]) await seedInstalledAgent(`@hintorg/${n}`);
    // A system agent: no `space_packages` row (enabled by absence), and it
    // sorts FIRST whatever its id.
    await seedPackage({ id: "@zsys/system-agent", orgId: null, source: "system" });
    // Installed but disabled in the space → in neither the page nor the count.
    await seedInstalledAgent("@hintorg/a0-disabled", { enabled: false });
    // Owned by the org but not installed here → invisible.
    await seedPackage({ id: "@hintorg/a0-uninstalled", orgId: ctx.orgId });
    // Another type → not an agent.
    await seedPackage({ id: "@hintorg/a0-skill", orgId: ctx.orgId, type: "skill" });
    await seedInstalledPackage(ctx.defaultSpaceId, "@hintorg/a0-skill");

    const page = await listRunnableAgents(scope, { limit: 3 });
    expect(page.agents.map((a) => a.package_id)).toEqual([
      "@zsys/system-agent",
      "@hintorg/a1",
      "@hintorg/a2",
    ]);
    expect(page.truncated).toBe(true);
    // 1 system + 5 enabled installs. Not 7: the disabled install is filtered
    // before the count, not after it.
    expect(page.total).toBe(6);

    // Control: a cap above the catalog returns it whole, with the same count.
    const whole = await listRunnableAgents(scope, { limit: 10 });
    expect(whole.agents).toHaveLength(6);
    expect(whole.truncated).toBe(false);
    expect(whole.total).toBe(6);
    const ids = new Set(whole.agents.map((a) => a.package_id));
    expect(ids.has("@hintorg/a0-disabled")).toBe(false);
    expect(ids.has("@hintorg/a0-uninstalled")).toBe(false);
    expect(ids.has("@hintorg/a0-skill")).toBe(false);
  });

  it("bounds skills the same way", async () => {
    for (const n of ["s1", "s2", "s3"]) {
      await seedPackage({
        id: `@hintorg/${n}`,
        orgId: ctx.orgId,
        type: "skill",
        draftManifest: { name: `@hintorg/${n}`, version: "1.0.0", type: "skill" },
      });
      await seedInstalledPackage(ctx.defaultSpaceId, `@hintorg/${n}`);
    }
    await seedInstalledPackage(ctx.defaultSpaceId, "@hintorg/s3", { enabled: false });

    const page = await listInstalledSkills(scope, { limit: 1 });
    expect(page.skills.map((s) => s.package_id)).toEqual(["@hintorg/s1"]);
    expect(page.skills[0]!.version).toBe("1.0.0");
    expect(page.truncated).toBe(true);
    expect(page.total).toBe(2);
  });

  it("reports an empty catalog as zero, not truncated", async () => {
    const page = await listRunnableAgents(scope);
    expect(page).toEqual({ agents: [], truncated: false, total: 0 });
  });
});
