// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, spacePackages, spaces } from "@appstrate/db/schema";
import { requirePermission } from "../middleware/require-permission.ts";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import { asRecord } from "@appstrate/core/safe-json";
import {
  homeWireForCaller,
  packageAccessSpaces,
  packagePermission,
  managesOrgCatalog,
  placementGrantsRead,
} from "../lib/package-access.ts";
import type { AppEnv } from "../types/index.ts";

export function createLibraryRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/library — all packages grouped by type with install state per space
  router.get("/", requirePermission("spaces", "read"), async (c) => {
    const orgId = c.get("orgId");

    const accessible = await packageAccessSpaces(c);
    const accessibleIds = accessible.map((space) => space.id);
    const orgSpaces = accessible
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
      .map(({ id, name, isDefault }) => ({ id, name, isDefault }));
    const orgCatalogAdmin = managesOrgCatalog(c);
    const readableSpaceIds = new Map(
      (["agent", "skill", "mcp-server", "integration"] as const).map((type) => [
        type,
        new Set(
          accessible
            .filter((space) => space.permissions.has(packagePermission(type, "read")))
            .map((space) => space.id),
        ),
      ]),
    );
    const rows = await db
      .select({
        id: packages.id,
        type: packages.type,
        installedAnywhere: sql<boolean>`EXISTS (SELECT 1 FROM ${spacePackages} sp INNER JOIN ${spaces} s ON s.id = sp.space_id WHERE sp.package_id = ${packages.id} AND s.org_id = ${orgId})`,
        source: packages.source,
        homeSpaceId: packages.homeSpaceId,
        draftManifest: packages.draftManifest,
        spaceId: spacePackages.spaceId,
      })
      .from(packages)
      .leftJoin(
        spacePackages,
        and(
          eq(spacePackages.packageId, packages.id),
          // Scope to org spaces only — prevents leaking install state from other orgs
          inArray(spacePackages.spaceId, accessibleIds),
        ),
      )
      .where(and(orgOrSystemFilter(orgId), notEphemeralFilter()))
      .orderBy(packages.id);

    // Group: packageId → { meta, installed_in[] }
    const pkgMap = new Map<
      string,
      {
        id: string;
        type: string;
        source: string;
        home_space_id: string | null;
        home_writable: boolean;
        name: string;
        description: string;
        installed_in: string[];
      }
    >();

    for (const row of rows) {
      const readable = readableSpaceIds.get(row.type);
      if (!readable?.size) continue;
      const readableInstallation = !!row.spaceId && readable.has(row.spaceId);
      // Installed where the caller reads, or homed there — the same rule the
      // detail routes apply, from the one predicate that states it.
      const placed = placementGrantsRead(row, row.spaceId ? [row.spaceId] : [], readable);
      // A package with NO HOME and no reachable installation is the org
      // catalog, which owners and admins also list. The NULL home is what
      // makes it theirs: one homed in a space — a personal space above all —
      // is listed through that space or not at all (spec §3.6).
      const orgCatalogEntry =
        row.homeSpaceId === null && !row.spaceId && orgCatalogAdmin && !row.installedAnywhere;
      if (!placed && row.source !== "system" && !orgCatalogEntry) continue;
      let entry = pkgMap.get(row.id);
      if (!entry) {
        const m = asRecord(row.draftManifest);
        entry = {
          id: row.id,
          type: row.type,
          source: row.source,
          // ONE contract for the pair, computed server-side (RBAC spec §6.9):
          // the home's id only when this caller reaches that space, and the
          // write verdict itself.
          ...homeWireForCaller(c, row, accessible),
          name: typeof m.display_name === "string" ? m.display_name : row.id,
          description: typeof m.description === "string" ? m.description : "",
          installed_in: [],
        };
        pkgMap.set(row.id, entry);
      }
      if (row.spaceId && readableInstallation) {
        entry.installed_in.push(row.spaceId);
      }
    }

    // Group by type
    type Entry = NonNullable<ReturnType<typeof pkgMap.get>>;
    const grouped: Record<string, Entry[]> = {
      agent: [],
      skill: [],
      "mcp-server": [],
      integration: [],
    };
    for (const pkg of pkgMap.values()) {
      grouped[pkg.type]?.push(pkg);
    }

    return c.json({
      object: "library",
      spaces: orgSpaces,
      packages: grouped,
    });
  });

  return router;
}
