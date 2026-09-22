// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  organizationMembers,
  packages,
  packageShares,
  spacePackages,
  user,
} from "@appstrate/db/schema";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import { asRecord } from "@appstrate/core/safe-json";
import {
  homeWireForCaller,
  packageAccessSpaces,
  packagePermission,
} from "../lib/package-access.ts";
import { isActiveHere } from "./package-activation.ts";
import { sharerView } from "./package-shares.ts";
import type { PackageType } from "@appstrate/core/validation";
import type { AppEnv } from "../types/index.ts";

const PACKAGE_TYPES = ["agent", "skill", "mcp-server", "integration"] as const;

/**
 * How a package reaches a space. The two placements of the rule
 * (`placementGrantsRead`, RBAC spec §6.9) plus the system escape — nothing
 * else puts a package on this list.
 */
type PlacementVia = "home" | "shared" | "system";

/** Whether the space RUNS what it was placed. */
type PlacementState = "active" | "inactive" | "none";

/** One (package, space) cell of the library map. */
interface Placement {
  space_id: string;
  via: PlacementVia;
  state: PlacementState;
  /**
   * Who offered it — on `shared` placements only, and `null` there when the
   * offer came from a home MOVE rather than from a person (`shared_by` is NULL
   * on those rows) or when that account is gone.
   */
  shared_by: { user_id: string; name: string } | null;
}

interface LibraryPackage {
  id: string;
  type: string;
  source: string;
  name: string;
  description: string;
  home_space_id: string | null;
  home_writable: boolean;
  home_deletable: boolean;
  home_shareable: boolean;
  placements: Placement[];
}

/**
 * The library — a map of PLACEMENTS, in its two shapes.
 *
 * A package sits in ONE home and reaches other spaces through `package_shares`;
 * `space_packages` says whether the space that holds it actually runs it. The
 * library projects exactly those three axes, one row per package and one
 * `placements` entry per space the package is placed in and the caller reads:
 *
 *   - `via` — WHY the package is there: its `home`, an offer (`shared`), or
 *     because it is a `system` package, readable everywhere by construction.
 *   - `state` — whether the space RUNS it: `active` (a placement row saying
 *     `enabled`), `inactive` (a row saying `false`), `none` (no row at all,
 *     i.e. an offer nobody has taken up yet).
 *
 * A pending offer is therefore not a section of its own: it is a placement with
 * `state: "none"`, behind the same switch as every other space. A separate
 * section would put one activation behind two buttons.
 *
 * `GET /api/library` (owners and admins) returns every space the caller reads;
 * `GET /api/spaces/{id}/library` narrows to the requested space, which is what
 * makes it a space's own page rather than an organization map. A package with
 * NO placement there is still listed when the caller could PLACE it — a system
 * package, or one whose home grants them `<type>:share` — since
 * `POST /api/spaces/{id}/packages` would create the offer with the activation.
 * Never into a PERSONAL destination: an offer into somebody's own space is
 * somebody else's act.
 */
export async function getPackageLibrary(c: Context<AppEnv>, spaceId?: string) {
  const orgId = c.get("orgId");

  const accessible = await packageAccessSpaces(c);
  const target = spaceId ? accessible.find((space) => space.id === spaceId) : undefined;
  const visibleSpaces = spaceId ? accessible.filter((space) => space.id === spaceId) : accessible;
  const accessibleIds = accessible.map((space) => space.id);
  const orgSpaces = visibleSpaces
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
    .map(({ id, name, isDefault }) => ({ id, name, isDefault }));
  // A PERSONAL space is its owner's, and an integration placed there runs on
  // their credentials — so the deployment's own integrations, which every team
  // space gets by construction, are not proposed in one. Nobody puts an
  // integration in somebody's private workspace, the platform included; the
  // owner reaches it through a team space. Every other system package stays
  // placed everywhere.
  const personalSpaceIds = new Set(
    accessible.filter((space) => space.ownerUserId !== null).map((space) => space.id),
  );
  // Per type, the spaces whose placements this caller may see at all: read
  // permission for that type, and — in the space form — the requested space
  // alone. A personal target additionally hides every other space, since its
  // page is its owner's and nobody else's.
  const readableSpaceIds = new Map<PackageType, Set<string>>(
    PACKAGE_TYPES.map((type) => [
      type,
      new Set(
        accessible
          .filter(
            (space) =>
              (!target?.ownerUserId || space.id === target.id) &&
              (!spaceId || space.id === spaceId) &&
              space.permissions.has(packagePermission(type, "read")),
          )
          .map((space) => space.id),
      ),
    ]),
  );

  // TWO reads for the whole map: the catalogue joined to its placement rows,
  // and the offers joined to the names behind them. Two queries rather than one
  // with a second LEFT JOIN, because a package placed in two spaces and offered
  // to three would fan out into six rows and every state read off them would be
  // ambiguous.
  const [rows, shareRows] = await Promise.all([
    db
      .select({
        id: packages.id,
        type: packages.type,
        source: packages.source,
        homeSpaceId: packages.homeSpaceId,
        draftManifest: packages.draftManifest,
        spaceId: spacePackages.spaceId,
        enabled: spacePackages.enabled,
      })
      .from(packages)
      .leftJoin(
        spacePackages,
        and(
          eq(spacePackages.packageId, packages.id),
          // Scope to org spaces only — never leak placement state from another org.
          inArray(spacePackages.spaceId, accessibleIds),
        ),
      )
      // Deliberately WITHOUT `listedFilter`. The library is the MANAGEMENT map,
      // not a catalogue: it is the only surface that shows WHERE a package sits
      // and whether the space runs it, and it is owner/admin-only. Dropping an
      // org's own unlisted package from it would leave no listing anywhere that
      // shows the thing its authors have to place, activate or delete.
      // Visibility is discoverability — the catalogue surfaces (the per-type
      // index, the caller-context hints) are where it applies.
      .where(and(orgOrSystemFilter(orgId), notEphemeralFilter()))
      .orderBy(packages.id),
    // The sharer is named only while they are still a MEMBER of this
    // organization. `package_shares.shared_by` is `ON DELETE SET NULL` on
    // `user`, so deleting the ACCOUNT clears it — but leaving the ORG clears
    // nothing, and this map is served to every owner and admin, on every row.
    // The membership join is therefore the filter, not a post-pass: a former
    // member's name never leaves the database. The projection off these columns
    // is `sharerView` (`services/package-shares.ts`), shared with
    // `GET …/shares` so the rule has one statement and not two.
    db
      .select({
        packageId: packageShares.packageId,
        spaceId: packageShares.spaceId,
        sharedBy: packageShares.sharedBy,
        sharerName: user.name,
      })
      .from(packageShares)
      .leftJoin(
        organizationMembers,
        and(
          eq(organizationMembers.userId, packageShares.sharedBy),
          eq(organizationMembers.orgId, orgId),
        ),
      )
      .leftJoin(user, eq(user.id, organizationMembers.userId))
      .where(inArray(packageShares.spaceId, accessibleIds)),
  ]);

  /** packageId → spaceId → the sharer, when the offer names one. */
  const offers = new Map<string, Map<string, { user_id: string; name: string } | null>>();
  for (const row of shareRows) {
    let bySpace = offers.get(row.packageId);
    if (!bySpace) offers.set(row.packageId, (bySpace = new Map()));
    bySpace.set(row.spaceId, sharerView(row));
  }

  /** packageId → spaceId → `enabled`, for the rows the caller's spaces hold. */
  const placementRows = new Map<string, Map<string, boolean>>();
  for (const row of rows) {
    if (!row.spaceId) continue;
    let bySpace = placementRows.get(row.id);
    if (!bySpace) placementRows.set(row.id, (bySpace = new Map()));
    bySpace.set(row.spaceId, row.enabled!);
  }

  // One row per package: the join above repeats a package once per placement
  // row, and the projection below reads the whole map at once.
  const catalogue = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!catalogue.has(row.id)) catalogue.set(row.id, row);

  const grouped: Record<string, LibraryPackage[]> = {
    agent: [],
    skill: [],
    "mcp-server": [],
    integration: [],
  };

  for (const row of catalogue.values()) {
    const type = row.type as PackageType;
    const readable = readableSpaceIds.get(type);
    if (!readable?.size) continue;
    const home = homeWireForCaller(row, accessible);
    const offeredIn = offers.get(row.id);
    const rowsBySpace = placementRows.get(row.id);

    const placements: Placement[] = [];
    for (const space of readable) {
      // The deployment's integrations are not PROPOSED in a personal space (see
      // `personalSpaceIds` above) — but a row is not a proposal, it is a
      // decision somebody already made there. Only the placement that exists by
      // construction alone is skipped; once the space holds a
      // `space_packages` row, the map must show it, or it hides a state the
      // owner set and can no longer see.
      const placementRow = rowsBySpace?.get(space);
      if (
        placementRow === undefined &&
        row.source === "system" &&
        type === "integration" &&
        personalSpaceIds.has(space)
      ) {
        continue;
      }
      const via: PlacementVia | null =
        row.source === "system"
          ? "system"
          : row.homeSpaceId === space
            ? "home"
            : offeredIn?.has(space)
              ? "shared"
              : null;
      if (via === null) continue;
      placements.push({
        space_id: space,
        via,
        state: placementState({ id: row.id, type, source: row.source }, placementRow),
        // Only an OFFER names an author. A home places the package by owning
        // it, and a system package by being shipped.
        shared_by: via === "shared" ? (offeredIn?.get(space) ?? null) : null,
      });
    }
    placements.sort((a, b) => a.space_id.localeCompare(b.space_id));

    // A package with no placement the caller reads is listed in ONE case, and
    // only in the SPACE form: it is a candidate the caller could put there in
    // one click — a package whose home grants them `<type>:share`, since
    // `POST /api/spaces/{id}/packages` creates the offer with the activation —
    // and never for a PERSONAL destination, where an offer is somebody else's
    // act. Nothing else earns a row: every package of the organization is
    // homed in one of its spaces (`packages_org_package_has_home`), so a
    // package with no placement here is one placed in spaces this caller does
    // not read, and the ORGANIZATION map is the page that shows it.
    if (placements.length === 0 && !(!!spaceId && !target?.ownerUserId && home.home_shareable))
      continue;

    const m = asRecord(row.draftManifest);
    grouped[row.type]?.push({
      id: row.id,
      type: row.type,
      source: row.source,
      // ONE contract for the home group, computed server-side (RBAC spec §6.9,
      // §6.10): the home's id only when this caller reaches that space, and the
      // write, delete and share verdicts themselves.
      ...home,
      name: typeof m.display_name === "string" ? m.display_name : row.id,
      description: typeof m.description === "string" ? m.description : "",
      placements,
    });
  }

  return {
    object: "library" as const,
    spaces: orgSpaces,
    packages: grouped,
  };
}

/**
 * Does this space RUN the package? A PROJECTION of the one rule
 * (`isActiveHere`, `services/package-activation.ts`), not a second statement of
 * it: that rule answers `active`, and the other two labels only say why it
 * answered no — `inactive` a row saying `false` (a system package included,
 * because a switch that changes nothing is worse than no switch), `none` no row
 * at all, which the library renders as a pending offer. Folding them together
 * would lose the difference between "nobody has taken this up" and "somebody
 * switched this off". PLACEMENT is settled by the caller — a `Placement` exists
 * only once `via` resolved — so an ORPHAN row never reaches here to be rendered
 * `inactive`, and `placed` is `true` by construction.
 */
function placementState(
  pkg: { id: string; type: PackageType; source: string },
  enabled: boolean | undefined,
): PlacementState {
  const row = enabled === undefined ? undefined : { enabled };
  return isActiveHere(pkg, row, true) ? "active" : row ? "inactive" : "none";
}
