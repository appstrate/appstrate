// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, applicationPackages, applications } from "@appstrate/db/schema";
import { requirePermission } from "../middleware/require-permission.ts";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import { asRecord } from "../lib/safe-json.ts";
import type { AppEnv } from "../types/index.ts";

export function createLibraryRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/library — all packages grouped by type with install state per app
  router.get("/", requirePermission("applications", "read"), async (c) => {
    const orgId = c.get("orgId");

    // Fetch apps and packages+installs in parallel
    const [orgApps, rows] = await Promise.all([
      db
        .select({
          id: applications.id,
          name: applications.name,
          isDefault: applications.isDefault,
        })
        .from(applications)
        .where(eq(applications.orgId, orgId))
        .orderBy(sql`CASE WHEN ${applications.isDefault} THEN 0 ELSE 1 END`),

      db
        .select({
          id: packages.id,
          type: packages.type,
          source: packages.source,
          draftManifest: packages.draftManifest,
          appId: applicationPackages.applicationId,
        })
        .from(packages)
        .leftJoin(
          applicationPackages,
          and(
            eq(applicationPackages.packageId, packages.id),
            // Scope to org apps only — prevents leaking install state from other orgs
            sql`${applicationPackages.applicationId} IN (SELECT ${applications.id} FROM ${applications} WHERE ${applications.orgId} = ${orgId})`,
          ),
        )
        .where(and(orgOrSystemFilter(orgId), notEphemeralFilter()))
        .orderBy(packages.id),
    ]);

    // Group: packageId → { meta, installedIn[] }
    const pkgMap = new Map<
      string,
      {
        id: string;
        type: string;
        source: string;
        name: string;
        description: string;
        installedIn: string[];
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
          name: typeof m.displayName === "string" ? m.displayName : row.id,
          description: typeof m.description === "string" ? m.description : "",
          installedIn: [],
        };
        pkgMap.set(row.id, entry);
      }
      if (row.appId) {
        entry.installedIn.push(row.appId);
      }
    }

    // Group by type
    type Entry = NonNullable<ReturnType<typeof pkgMap.get>>;
    const grouped: Record<string, Entry[]> = {
      agent: [],
      skill: [],
      tool: [],
      provider: [],
    };
    for (const pkg of pkgMap.values()) {
      grouped[pkg.type]?.push(pkg);
    }

    return c.json({
      object: "library",
      applications: orgApps,
      packages: grouped,
    });
  });

  return router;
}
