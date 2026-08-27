// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, spacePackages, spaces } from "@appstrate/db/schema";
import { requirePermission } from "../middleware/require-permission.ts";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import { asRecord } from "@appstrate/core/safe-json";
import type { AppEnv } from "../types/index.ts";

export function createLibraryRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/library — all packages grouped by type with install state per space
  router.get("/", requirePermission("spaces", "read"), async (c) => {
    const orgId = c.get("orgId");

    // Fetch spaces and packages+installs in parallel
    const [orgSpaces, rows] = await Promise.all([
      db
        .select({
          id: spaces.id,
          name: spaces.name,
          isDefault: spaces.isDefault,
        })
        .from(spaces)
        .where(eq(spaces.orgId, orgId))
        .orderBy(sql`CASE WHEN ${spaces.isDefault} THEN 0 ELSE 1 END`),

      db
        .select({
          id: packages.id,
          type: packages.type,
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
            sql`${spacePackages.spaceId} IN (SELECT ${spaces.id} FROM ${spaces} WHERE ${spaces.orgId} = ${orgId})`,
          ),
        )
        .where(and(orgOrSystemFilter(orgId), notEphemeralFilter()))
        .orderBy(packages.id),
    ]);

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
      if (row.spaceId) {
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
