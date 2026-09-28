// SPDX-License-Identifier: Apache-2.0

/**
 * `listActivePackageHints` (through `listRunnableAgents` /
 * `listActiveSkills`) is bounded IN SQL: the activation filter and the cap
 * sit in the query, and `total` is a window count over the filtered set. It
 * runs twice on every chat turn's TTFT path, so it must not load the whole
 * catalog to keep `limit` rows of it.
 *
 * What the SQL rewrite could get wrong, and what is pinned against it:
 *   - `total` counted AFTER the cap (a plain `LIMIT` with `rows.length`) would
 *     report the page size, not the catalog size → `total` is asserted above
 *     `items.length` with `truncated` true;
 *   - the activation filter applied to the page but not the count → a
 *     deactivated placement is asserted absent from `total` as well as from
 *     `items`;
 *   - a different total order than `listActivePackages` (system first,
 *     then id — load-bearing for the prompt cache) → the page's ids are
 *     asserted in that order, with a system package seeded to lead it.
 *
 * The last `describe` pins the other half of the contract: the hints and the
 * per-type INDEX page render the same set. They are two queries over one rule
 * (`activeHereSql`), and nothing but a table makes them agree — a caller
 * context that names an agent the index does not show is a model told it may
 * invoke something the page has no row for, and the reverse is a launch
 * control the model never hears about.
 */

import { afterEach, describe, it, expect, beforeEach } from "bun:test";
import { listRunnableAgents, listActiveSkills } from "../../../src/services/space-packages.ts";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageShare, seedSpace, seedSpacePackage } from "../../helpers/seed.ts";
import {
  initSystemIntegrations,
  __resetSystemIntegrationsForTest,
} from "../../../src/services/integration-client-registry.ts";
import type { SpaceScope } from "../../../src/lib/scope.ts";

describe("listActivePackageHints — bounded in SQL", () => {
  let ctx: TestContext;
  let scope: SpaceScope;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "hintorg" });
    scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
  });

  async function seedActiveAgent(id: string, overrides?: { enabled?: boolean }): Promise<void> {
    await seedPackage({
      id,
      orgId: ctx.orgId,
      homeSpaceId: ctx.defaultSpaceId,
      draftManifest: {
        name: id,
        version: "0.1.0",
        type: "agent",
        display_name: id.split("/")[1],
        description: "An agent.",
      },
    });
    await seedSpacePackage(ctx.defaultSpaceId, id, overrides);
  }

  it("caps the page, counts the whole enabled catalog, and keeps the system-first order", async () => {
    // Five active local placements, ids chosen so the id tie-break is known.
    for (const n of ["a1", "a2", "a3", "a4", "a5"]) await seedActiveAgent(`@hintorg/${n}`);
    // A system agent: no `space_packages` row (active by construction), and it
    // sorts FIRST whatever its id.
    await seedPackage({ id: "@zsys/system-agent", orgId: null, source: "system" });
    // Placed but switched off in the space → in neither the page nor the count.
    await seedActiveAgent("@hintorg/a0-disabled", { enabled: false });
    // Owned by the org but not installed here → invisible.
    await seedPackage({
      id: "@hintorg/a0-uninstalled",
      orgId: ctx.orgId,
      homeSpaceId: ctx.defaultSpaceId,
    });
    // Another type → not an agent.
    await seedPackage({
      id: "@hintorg/a0-skill",
      orgId: ctx.orgId,
      type: "skill",
      homeSpaceId: ctx.defaultSpaceId,
    });
    await seedSpacePackage(ctx.defaultSpaceId, "@hintorg/a0-skill");

    const page = await listRunnableAgents(scope, { limit: 3 });
    expect(page.agents.map((a) => a.packageId)).toEqual([
      "@zsys/system-agent",
      "@hintorg/a1",
      "@hintorg/a2",
    ]);
    expect(page.truncated).toBe(true);
    // 1 system + 5 active placements. Not 7: the deactivated one is filtered
    // before the count, not after it.
    expect(page.total).toBe(6);

    // Control: a cap above the catalog returns it whole, with the same count.
    const whole = await listRunnableAgents(scope, { limit: 10 });
    expect(whole.agents).toHaveLength(6);
    expect(whole.truncated).toBe(false);
    expect(whole.total).toBe(6);
    const ids = new Set(whole.agents.map((a) => a.packageId));
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
        homeSpaceId: ctx.defaultSpaceId,
        draftManifest: { name: `@hintorg/${n}`, version: "1.0.0", type: "skill" },
      });
      await seedSpacePackage(ctx.defaultSpaceId, `@hintorg/${n}`);
    }
    await seedSpacePackage(ctx.defaultSpaceId, "@hintorg/s3", { enabled: false });

    const page = await listActiveSkills(scope, { limit: 1 });
    expect(page.skills.map((s) => s.packageId)).toEqual(["@hintorg/s1"]);
    expect(page.skills[0]!.version).toBe("1.0.0");
    expect(page.truncated).toBe(true);
    expect(page.total).toBe(2);
  });

  it("reports an empty catalog as zero, not truncated", async () => {
    const page = await listRunnableAgents(scope);
    expect(page).toEqual({ agents: [], truncated: false, total: 0 });
  });
});

/**
 * The caller-context hints and the per-type index page, over one fixture that
 * holds every shape a space can be in: a system package with no row, the same
 * with a row saying `false`, a local package switched on, one switched off, an
 * offer nobody took up, and an ORPHAN row.
 *
 * Both listings are compared against the SAME written-out set, rather than
 * against each other: "they agree" is worth nothing when they agree on the
 * wrong thing, and these two share `activeHereSql`, so a mistake in the rule
 * moves both at once.
 */
describe("the hints and the type index render one set", () => {
  const app = getTestApp();
  let ctx: TestContext;
  let scope: SpaceScope;

  /** A system integration the deployment OFFERS — on with no row at all. */
  const SYS_ON = "@sysorg/offered-integration";
  /** A system integration the deployment ships but does NOT offer. */
  const SYS_SHIPPED = "@sysorg/shipped-integration";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "twoviews" });
    scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    initSystemIntegrations([{ id: SYS_ON, clients: [] }]);
  });

  afterEach(() => {
    __resetSystemIntegrationsForTest();
  });

  async function indexIds(path: string): Promise<string[]> {
    const res = await app.request(path, { headers: authHeaders(ctx) });
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { data: { id: string }[] }).data.map((row) => row.id);
  }

  it("agrees cell for cell — system, local, offered, orphaned", async () => {
    const home = ctx.defaultSpaceId;
    const elsewhere = (await seedSpace({ orgId: ctx.orgId, name: "Elsewhere" })).id;

    // 1. A SYSTEM agent with no row — on by the deployment's default.
    await seedPackage({ id: "@asys/system-agent", orgId: null, source: "system" });
    // 2. The same, with a row saying `false` — the operator's decision wins.
    await seedPackage({ id: "@asys/system-off", orgId: null, source: "system" });
    await seedSpacePackage(home, "@asys/system-off", { enabled: false });
    // 3. A local agent homed here and switched ON.
    await seedPackage({ id: "@twoviews/local-on", orgId: ctx.orgId, homeSpaceId: home });
    await seedSpacePackage(home, "@twoviews/local-on");
    // 4. A local agent homed here and switched OFF.
    await seedPackage({ id: "@twoviews/local-off", orgId: ctx.orgId, homeSpaceId: home });
    await seedSpacePackage(home, "@twoviews/local-off", { enabled: false });
    // 5. OFFERED here and never taken up — placed, not active.
    await seedPackage({ id: "@twoviews/offered", orgId: ctx.orgId, homeSpaceId: elsewhere });
    await seedPackageShare(home, "@twoviews/offered");
    // 6. An ORPHAN row: `enabled`, with neither a home here nor an offer.
    await seedPackage({ id: "@twoviews/orphan", orgId: ctx.orgId, homeSpaceId: elsewhere });
    await seedSpacePackage(home, "@twoviews/orphan");

    const expected = ["@asys/system-agent", "@twoviews/local-on"];

    const hinted = (await listRunnableAgents(scope, { limit: 50 })).agents.map((a) => a.packageId);
    const indexed = await indexIds("/api/packages/agents");
    expect(hinted.slice().sort()).toEqual(expected);
    expect(indexed.slice().sort()).toEqual(expected);
    // `GET /api/agents` is the agents index the SPA renders, and it is a third
    // query over the same rule.
    expect((await indexIds("/api/agents")).slice().sort()).toEqual(expected);
  });

  it("agrees on the integration default, which is the one per-type exception", async () => {
    // Integrations do not default on because they are `source: system` — only
    // the subset `SYSTEM_INTEGRATIONS` names does. A listing that read `source`
    // alone would switch a shipped catalogue of tens of them on in every space.
    await seedPackage({ id: SYS_ON, orgId: null, type: "integration", source: "system" });
    await seedPackage({ id: SYS_SHIPPED, orgId: null, type: "integration", source: "system" });

    expect(await indexIds("/api/packages/integrations")).toEqual([SYS_ON]);
  });
});
