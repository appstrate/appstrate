// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, spacePackages, spaces } from "@appstrate/db/schema";
import { requirePermission } from "../middleware/require-permission.ts";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import { asRecord } from "@appstrate/core/safe-json";
import {
  packageAccessSpaces,
  packagePermission,
  managesOrgCatalog,
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
        name: string;
        description: string;
        installed_in: string[];
      }
    >();

    for (const row of rows) {
      const readable = readableSpaceIds.get(row.type);
      if (!readable?.size) continue;
      const readableInstallation = row.spaceId && readable.has(row.spaceId);
      if (row.spaceId && !readableInstallation && row.source !== "system") continue;
      if (!row.spaceId && row.source !== "system" && !(orgCatalogAdmin && !row.installedAnywhere))
        continue;
      let entry = pkgMap.get(row.id);
      if (!entry) {
        const m = asRecord(row.draftManifest);
        entry = {
          id: row.id,
          type: row.type,
          source: row.source,
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
