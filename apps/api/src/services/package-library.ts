// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, packageShares, spacePackages } from "@appstrate/db/schema";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import { asRecord } from "@appstrate/core/safe-json";
import {
  homeWireForCaller,
  packageAccessSpaces,
  packagePermission,
  managesOrgCatalog,
  placementGrantsRead,
} from "../lib/package-access.ts";
import { listSharedNotInstalled } from "./package-shares.ts";
import type { PackageType } from "@appstrate/core/validation";
import type { AppEnv } from "../types/index.ts";

/**
 * Package discovery with either organization-wide or single-space installation
 * state.
 *
 * The CANDIDATES a target space is offered are exactly what the caller could
 * put there (plan decision 10), so the listing cannot propose a package the
 * install route would refuse:
 *
 *   - a TEAM target: already PLACED there (homed or shared) — or placeable,
 *     i.e. the caller holds `<type>:share` in the package's home (`home_shareable`,
 *     which is also true for the org catalogue they administer), since
 *     `POST /api/spaces/{id}/packages` then creates the offer with the install.
 *   - a PERSONAL target: PLACED only, plus system packages other than
 *     integrations. Nobody shares INTO their own space on their own behalf; an
 *     offer is somebody else's act, and this listing is where it is taken up.
 *   - no target (the organization library): everything the caller reads
 *     anywhere, which is the admin surface over the catalogue. It carries no
 *     `shared` section — an offer is addressed to a space, and it is that
 *     space's library that presents it.
 */
export async function getPackageLibrary(c: Context<AppEnv>, spaceId?: string) {
  const orgId = c.get("orgId");

  const accessible = await packageAccessSpaces(c);
  // Only the target space's state and offers leave this projection.
  const target = spaceId ? accessible.find((space) => space.id === spaceId) : undefined;
  const visibleSpaces = spaceId ? accessible.filter((space) => space.id === spaceId) : accessible;
  const accessibleIds = accessible.map((space) => space.id);
  const orgSpaces = visibleSpaces
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
    .map(({ id, name, isDefault }) => ({ id, name, isDefault }));
  const orgCatalogAdmin = !target?.ownerUserId && managesOrgCatalog(c);
  // `packageAccessSpaces` never loads somebody else's personal space, so any
  // owned space in the set is the CALLER's own — the destination of an offer
  // made to them as a person.
  const ownPersonalSpaceId = accessible.find((space) => space.ownerUserId !== null)?.id ?? null;
  const readableSpaceIds = new Map(
    (["agent", "skill", "mcp-server", "integration"] as const).map((type) => [
      type,
      new Set(
        accessible
          .filter(
            (space) =>
              (!target?.ownerUserId || space.id === target.id) &&
              space.permissions.has(packagePermission(type, "read")),
          )
          .map((space) => space.id),
      ),
    ]),
  );
  const [rows, shareRows, shared] = await Promise.all([
    db
      .select({
        id: packages.id,
        type: packages.type,
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
      .orderBy(packages.id),
    // The SHARE half of the placement rule (RBAC spec §6.9), for every
    // accessible space. A SEPARATE query rather than a second LEFT JOIN above:
    // joined, a package installed in two spaces and offered to three would fan
    // out into six rows and `installed_in` would count each installation three
    // times. Loaded for `accessibleIds` — the same breadth as the installation
    // join, since a package offered to a space the caller reads is placed there
    // whether or not that space is the target.
    db
      .select({ packageId: packageShares.packageId, spaceId: packageShares.spaceId })
      .from(packageShares)
      .where(inArray(packageShares.spaceId, accessibleIds)),
    // The OFFERS still waiting on a decision (RBAC spec §6.10), for the TARGET
    // space alone — the organization catalogue below returns no `shared`
    // section at all, so asking for one there would be a query nobody reads.
    // The per-type read filter is applied below, where the type is known.
    spaceId ? listSharedNotInstalled(visibleSpaces.map((space) => space.id)) : Promise.resolve([]),
  ]);
  const sharedIn = new Map<string, string[]>();
  for (const row of shareRows) {
    const spacesForPackage = sharedIn.get(row.packageId);
    if (spacesForPackage) spacesForPackage.push(row.spaceId);
    else sharedIn.set(row.packageId, [row.spaceId]);
  }

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
    if (
      !readable?.size ||
      (spaceId && !target?.permissions.has(packagePermission(row.type, "read")))
    )
      continue;
    const readableInstallation = !!row.spaceId && readable.has(row.spaceId);
    // PLACED — homed or shared, the one predicate that states the rule
    // (RBAC spec §6.9). Evaluated against the TARGET alone when one is named:
    // a package placed in some OTHER space the caller reads is not a candidate
    // for this one, which is the whole point of decision 1. Without a target
    // this is the organization library, and the set is every readable space.
    const placementSpaces = spaceId ? new Set([spaceId]) : readable;
    const placed = placementGrantsRead(row, sharedIn.get(row.id) ?? [], placementSpaces);
    const home = homeWireForCaller(c, row, accessible);
    // A package with NO HOME is the organization catalogue, which owners and
    // admins list wherever they are. The NULL home is the WHOLE condition: one
    // homed in a space — a personal space above all — is listed through that
    // space or not at all (spec §3.6).
    const orgCatalogEntry = row.homeSpaceId === null && orgCatalogAdmin;
    // PLACEABLE — not placed in the target yet, but the caller holds
    // `<type>:share` in its home, so `POST /api/spaces/{id}/packages` would
    // create the offer along with the installation (plan decision 2). Listing
    // it is what makes the library say the truth about that route instead of
    // offering packages the install would refuse. Never for a PERSONAL target:
    // an offer into somebody's own space is somebody ELSE's act, and the owner
    // takes it up from the `shared` section below.
    const placeable = !!spaceId && !target?.ownerUserId && home.home_shareable;
    const systemAvailable =
      row.source === "system" && (!target?.ownerUserId || row.type !== "integration");
    if (!placed && !placeable && !systemAvailable && !orgCatalogEntry) continue;
    // An OFFER is not a matrix entry. When a space is the target, the matrix
    // answers "where is this activated, and where can I activate it"; an offer
    // nobody has taken up is a decision still owed, and `shared` below is its
    // one home — carrying the sharer's name and the wording that states the
    // act. Listed in both, the same install sat behind two different buttons.
    // The whole criterion is "its only placement here is that offer": homed
    // here, or installed here, and it is a matrix entry like any other. No
    // exclusion without a target: the organization library has no `shared`
    // section to move the row into, and its matrix IS the placement map.
    const installedInTarget = readableInstallation && row.spaceId === spaceId;
    const offeredHere = (sharedIn.get(row.id) ?? []).some((id) => placementSpaces.has(id));
    if (spaceId && offeredHere && !installedInTarget && row.homeSpaceId !== spaceId) continue;
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
        ...home,
        name: m.name,
        description: m.description,
        installed_in: [],
      };
      pkgMap.set(row.id, entry);
    }
    if (row.spaceId && readableInstallation && (!spaceId || row.spaceId === spaceId)) {
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
        // Whether the offer landed in the caller's OWN personal space — what
        // lets the SPA word it as "added to my space" rather than "install into
        // <team>". The route is the same either way (`POST
        // /api/spaces/{spaceId}/packages`); only the wording differs.
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

  return {
    object: "library" as const,
    spaces: orgSpaces,
    packages: grouped,
    // The offers belong to the space they were made to. Without a target this
    // is the organization CATALOGUE — an administrative view of what exists and
    // where it is placed, not a recipient's inbox — so the section is absent
    // there, not empty: an owner browsing the catalogue was being shown other
    // people's pending decisions as if they were their own.
    ...(spaceId ? { shared: sharedWithMe } : {}),
  };
}
