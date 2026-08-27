// SPDX-License-Identifier: Apache-2.0

/**
 * Non-regression lock for the dependency-graph reads of
 * `services/package-items/crud.ts`.
 *
 * `used_by_agents` (list) and `agents` (detail / delete pre-check) used to be
 * computed in JS after loading EVERY org package's `draft_manifest` jsonb.
 * They are now SQL aggregates over the same rows. These tests pin the observable
 * semantics — tenant scoping, ephemeral exclusion, self-reference, multi-map
 * counting — so the two implementations cannot drift apart silently.
 *
 * The list test additionally compares the service output against a JS oracle
 * that reproduces the previous algorithm on the same fixture.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and } from "drizzle-orm";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedInstalledPackage } from "../../helpers/seed.ts";
import { packages } from "@appstrate/db/schema";
import { extractDependencies } from "@appstrate/core/dependencies";
import { buildPackageId } from "@appstrate/core/naming";
import { scopedWhere } from "../../../src/lib/db-helpers.ts";
import { notEphemeralFilter } from "../../../src/lib/package-helpers.ts";
import { parseDraftManifest } from "../../../src/lib/manifest-utils.ts";
import {
  listOrgItems,
  getOrgItem,
  deleteOrgItem,
} from "../../../src/services/package-items/crud.ts";
import { CONFIG_BY_TYPE } from "../../../src/services/package-items/config.ts";

/**
 * The pre-SQL implementation, verbatim: load every non-ephemeral org package's
 * manifest and count dependency edges in JS. Used as the oracle the SQL
 * aggregate must agree with.
 */
async function legacyCountMap(orgId: string): Promise<Map<string, number>> {
  const countMap = new Map<string, number>();
  const allOrgPkgs = await db
    .select({ id: packages.id, draftManifest: packages.draftManifest })
    .from(packages)
    .where(and(scopedWhere(packages, { orgId }), notEphemeralFilter()));
  for (const pkg of allOrgPkgs) {
    if (!pkg.draftManifest) continue;
    const deps = extractDependencies(parseDraftManifest(pkg.draftManifest));
    for (const dep of deps) {
      const depId = buildPackageId(dep.depScope, dep.depName);
      countMap.set(depId, (countMap.get(depId) ?? 0) + 1);
    }
  }
  return countMap;
}

function agentManifest(id: string, dependencies: Record<string, unknown>) {
  return {
    name: id,
    version: "0.1.0",
    type: "agent",
    description: "Test agent",
    dependencies,
  };
}

describe("package-items dependency counts", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "depcount" });
  });

  describe("used_by_agents (listOrgItems)", () => {
    beforeEach(async () => {
      // Three skills: one used twice, one used once, one unused.
      for (const name of ["shared-skill", "solo-skill", "unused-skill"]) {
        await seedPackage({
          id: `@depcount/${name}`,
          orgId: ctx.orgId,
          type: "skill",
          createdBy: ctx.user.id,
        });
        await seedInstalledPackage(ctx.defaultSpaceId, `@depcount/${name}`);
      }

      await seedPackage({
        id: "@depcount/agent-a",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: agentManifest("@depcount/agent-a", {
          skills: { "@depcount/shared-skill": "^0.1.0", "@depcount/solo-skill": "^0.1.0" },
        }),
      });
      await seedPackage({
        id: "@depcount/agent-b",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: agentManifest("@depcount/agent-b", {
          skills: { "@depcount/shared-skill": "^0.1.0" },
        }),
      });
    });

    it("matches the legacy JS count for every listed item", async () => {
      const items = await listOrgItems(ctx.orgId, CONFIG_BY_TYPE.skill, ctx.defaultSpaceId);
      const oracle = await legacyCountMap(ctx.orgId);

      expect(items.length).toBe(3);
      for (const item of items) {
        expect(item.used_by_agents).toBe(oracle.get(item.id) ?? 0);
      }

      const byId = new Map(items.map((i) => [i.id, i.used_by_agents]));
      expect(byId.get("@depcount/shared-skill")).toBe(2);
      expect(byId.get("@depcount/solo-skill")).toBe(1);
      expect(byId.get("@depcount/unused-skill")).toBe(0);
    });

    it("ignores ephemeral shadow packages and other orgs' manifests", async () => {
      await seedPackage({
        id: "@inline/shadow-run",
        orgId: ctx.orgId,
        ephemeral: true,
        createdBy: ctx.user.id,
        draftManifest: agentManifest("@inline/shadow-run", {
          skills: { "@depcount/unused-skill": "^0.1.0" },
        }),
      });

      const other = await createTestContext({ orgSlug: "otherorg" });
      await seedPackage({
        id: "@otherorg/agent",
        orgId: other.orgId,
        createdBy: other.user.id,
        draftManifest: agentManifest("@otherorg/agent", {
          skills: { "@depcount/unused-skill": "^0.1.0" },
        }),
      });

      const items = await listOrgItems(ctx.orgId, CONFIG_BY_TYPE.skill, ctx.defaultSpaceId);
      const byId = new Map(items.map((i) => [i.id, i.used_by_agents]));
      expect(byId.get("@depcount/unused-skill")).toBe(0);
      expect(byId.get("@depcount/shared-skill")).toBe(2);
    });

    it("counts every dependency map, including a self-reference", async () => {
      await seedPackage({
        id: "@depcount/mcp-one",
        orgId: ctx.orgId,
        type: "mcp-server",
        createdBy: ctx.user.id,
        // Self-reference: the legacy loop counted it, so the SQL must too.
        draftManifest: agentManifest("@depcount/mcp-one", {
          mcp_servers: { "@depcount/mcp-one": "^0.1.0" },
        }),
      });
      await seedInstalledPackage(ctx.defaultSpaceId, "@depcount/mcp-one");
      await seedPackage({
        id: "@depcount/agent-c",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: agentManifest("@depcount/agent-c", {
          mcp_servers: { "@depcount/mcp-one": "^0.1.0" },
          integrations: { "@depcount/mcp-one": "^0.1.0" },
        }),
      });

      const items = await listOrgItems(ctx.orgId, CONFIG_BY_TYPE["mcp-server"], ctx.defaultSpaceId);
      const oracle = await legacyCountMap(ctx.orgId);
      const row = items.find((i) => i.id === "@depcount/mcp-one");
      expect(row?.used_by_agents).toBe(oracle.get("@depcount/mcp-one") ?? 0);
      // self + agent-c's mcp_servers entry + agent-c's integrations entry
      expect(row?.used_by_agents).toBe(3);
    });

    it("survives a manifest whose dependency map is not an object", async () => {
      await seedPackage({
        id: "@depcount/broken-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: { name: "@depcount/broken-agent", dependencies: { skills: "nonsense" } },
      });
      await seedPackage({
        id: "@depcount/no-manifest",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: null,
      });

      const items = await listOrgItems(ctx.orgId, CONFIG_BY_TYPE.skill, ctx.defaultSpaceId);
      const byId = new Map(items.map((i) => [i.id, i.used_by_agents]));
      expect(byId.get("@depcount/shared-skill")).toBe(2);
    });
  });

  describe("dependent packages (getOrgItem / deleteOrgItem)", () => {
    beforeEach(async () => {
      await seedPackage({
        id: "@depcount/used-skill",
        orgId: ctx.orgId,
        type: "skill",
        createdBy: ctx.user.id,
      });
      await seedPackage({
        id: "@depcount/free-skill",
        orgId: ctx.orgId,
        type: "skill",
        createdBy: ctx.user.id,
      });
      await seedPackage({
        id: "@depcount/consumer",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          ...agentManifest("@depcount/consumer", {
            skills: { "@depcount/used-skill": "^0.1.0" },
          }),
          display_name: "Consumer Agent",
        },
      });
    });

    it("reports the dependent with its manifest display_name", async () => {
      const item = await getOrgItem(ctx.orgId, "@depcount/used-skill", CONFIG_BY_TYPE.skill);
      expect(item?.agents).toEqual([{ id: "@depcount/consumer", display_name: "Consumer Agent" }]);
    });

    it("falls back to the package id when display_name is not a string", async () => {
      await seedPackage({
        id: "@depcount/unnamed",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          ...agentManifest("@depcount/unnamed", {
            skills: { "@depcount/free-skill": "^0.1.0" },
          }),
          display_name: 42,
        },
      });

      const item = await getOrgItem(ctx.orgId, "@depcount/free-skill", CONFIG_BY_TYPE.skill);
      expect(item?.agents).toEqual([
        { id: "@depcount/unnamed", display_name: "@depcount/unnamed" },
      ]);
    });

    it("blocks deletion while referenced and allows it once free", async () => {
      const blocked = await deleteOrgItem(ctx.orgId, "@depcount/used-skill", CONFIG_BY_TYPE.skill);
      expect(blocked.ok).toBe(false);
      expect(blocked.error).toBe("IN_USE");
      expect(blocked.dependents?.map((d) => d.id)).toEqual(["@depcount/consumer"]);

      const free = await deleteOrgItem(ctx.orgId, "@depcount/free-skill", CONFIG_BY_TYPE.skill);
      expect(free.ok).toBe(true);
    });

    it("never reports a self-reference or another org's package as a dependent", async () => {
      await seedPackage({
        id: "@depcount/self-ref",
        orgId: ctx.orgId,
        type: "skill",
        createdBy: ctx.user.id,
        draftManifest: agentManifest("@depcount/self-ref", {
          skills: { "@depcount/self-ref": "^0.1.0" },
        }),
      });
      const other = await createTestContext({ orgSlug: "otherorg2" });
      await seedPackage({
        id: "@otherorg2/agent",
        orgId: other.orgId,
        createdBy: other.user.id,
        draftManifest: agentManifest("@otherorg2/agent", {
          skills: { "@depcount/self-ref": "^0.1.0" },
        }),
      });

      const item = await getOrgItem(ctx.orgId, "@depcount/self-ref", CONFIG_BY_TYPE.skill);
      expect(item?.agents).toEqual([]);
    });
  });
});
