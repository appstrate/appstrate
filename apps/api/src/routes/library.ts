// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packageDistTags, packages, spacePackages, spaces } from "@appstrate/db/schema";
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
import { listSharedNotInstalled } from "../services/package-shares.ts";
import type { PackageType } from "@appstrate/core/validation";
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
    // `packageAccessSpaces` never loads somebody else's personal space, so any
    // owned space in the set is the CALLER's own — the destination of an
    // accepted share and the only space whose version pin they may re-take.
    const ownPersonalSpaceId = accessible.find((space) => space.ownerUserId !== null)?.id ?? null;
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
    const [rows, shared] = await Promise.all([
      db
        .select({
          id: packages.id,
          type: packages.type,
          installedAnywhere: sql<boolean>`EXISTS (SELECT 1 FROM ${spacePackages} sp INNER JOIN ${spaces} s ON s.id = sp.space_id WHERE sp.package_id = ${packages.id} AND s.org_id = ${orgId})`,
          source: packages.source,
          homeSpaceId: packages.homeSpaceId,
          draftManifest: packages.draftManifest,
          spaceId: spacePackages.spaceId,
          spaceVersionId: spacePackages.versionId,
          latestVersionId: packageDistTags.versionId,
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
        .leftJoin(
          packageDistTags,
          and(eq(packageDistTags.packageId, packages.id), eq(packageDistTags.tag, "latest")),
        )
        .where(and(orgOrSystemFilter(orgId), notEphemeralFilter()))
        .orderBy(packages.id),
      // The OFFERS still waiting on a decision (RBAC spec §6.10). Loaded for
      // every accessible space; the per-type read filter is applied below,
      // where the package's type is known.
      listSharedNotInstalled(accessibleIds),
    ]);

    // Group: packageId → { meta, installed_in[] }
    const pkgMap = new Map<
      string,
      {
        id: string;
        type: string;
        source: string;
        home_space_id: string | null;
        home_writable: boolean;
        home_shareable: boolean;
        name: string;
        description: string;
        installed_in: string[];
        update_available: boolean;
      }
    >();
    /** Metadata for every package of the org, share section included. */
    const meta = new Map<
      string,
      { type: PackageType; source: string; name: string; description: string }
    >();

    for (const row of rows) {
      if (!meta.has(row.id)) {
        const m = asRecord(row.draftManifest);
        meta.set(row.id, {
          type: row.type as PackageType,
          source: row.source,
          name: typeof m.display_name === "string" ? m.display_name : row.id,
          description: typeof m.description === "string" ? m.description : "",
        });
      }
      const readable = readableSpaceIds.get(row.type);
      if (!readable?.size) continue;
      const readableInstallation = !!row.spaceId && readable.has(row.spaceId);
      // Installed where the caller reads, or homed there — the same rule the
      // detail routes apply, from the one predicate that states it. The SHARE
      // half of that predicate is applied through the `shared` section below,
      // which is what those placements are for.
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
        const m = meta.get(row.id)!;
        entry = {
          id: row.id,
          type: row.type,
          source: row.source,
          // ONE contract for the trio, computed server-side (RBAC spec §6.9,
          // §6.10): the home's id only when this caller reaches that space,
          // and the write and share verdicts themselves.
          ...homeWireForCaller(c, row, accessible),
          name: m.name,
          description: m.description,
          installed_in: [],
          update_available: false,
        };
        pkgMap.set(row.id, entry);
      }
      if (row.spaceId && readableInstallation) {
        entry.installed_in.push(row.spaceId);
      }
      // An ACCEPTED SHARE in the caller's own personal space is version-PINNED
      // (plan decision 6), so it does not follow `latest` — the owner takes a
      // new version by re-accepting, which is what this flag offers. Their own
      // packages (homed there) are unpinned, and team-space installations track
      // `latest`; neither has anything to report.
      if (
        row.spaceId !== null &&
        row.spaceId === ownPersonalSpaceId &&
        row.homeSpaceId !== ownPersonalSpaceId &&
        row.spaceVersionId !== null &&
        row.latestVersionId !== null &&
        row.latestVersionId !== row.spaceVersionId
      ) {
        entry.update_available = true;
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

    const sharedWithMe = shared.flatMap((offer) => {
      const m = meta.get(offer.packageId);
      // A share whose package the caller may not read in the offered space is
      // not an offer they can see — same per-type read half as the listing.
      if (!m || !readableSpaceIds.get(m.type)?.has(offer.spaceId)) return [];
      return [
        {
          id: offer.packageId,
          type: m.type,
          source: m.source,
          name: m.name,
          description: m.description,
          space_id: offer.spaceId,
          // `POST …/shares/accept` installs into the caller's own personal
          // space and nowhere else, so only such an offer has that affordance.
          personal: offer.spaceId === ownPersonalSpaceId,
          // The service's row is camelCase; the wire is snake_case, and this is
          // the boundary (`docs/CASING_CONVENTIONS.md`).
          shared_by: offer.sharedBy && {
            user_id: offer.sharedBy.userId,
            name: offer.sharedBy.name,
          },
        },
      ];
    });

    return c.json({
      object: "library",
      spaces: orgSpaces,
      packages: grouped,
      shared: sharedWithMe,
    });
  });

  return router;
}
