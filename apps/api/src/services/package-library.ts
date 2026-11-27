// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  organizationMembers,
  packageTypeValues,
  type PackageType,
  packageDistTags,
  packages,
  spacePackages,
  user,
} from "@appstrate/db/schema";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import { asRecord } from "@appstrate/core/safe-json";
import {
  packagePermission,
  spacePackagePermission,
  type CorePermission,
} from "@appstrate/core/permissions";
import { callerMayOffer, homeWireForCaller, packageAccessSpaces } from "../lib/package-access.ts";
import {
  isActiveEverywhereByDefault,
  isActiveHere,
  placementVia,
  type ActivatablePackage,
  type PlacementVia,
} from "./package-activation.ts";
import { notFound } from "../lib/errors.ts";
import { listRuntimeBoundSystemIntegrationIds } from "./system-packages.ts";
import { sharerView } from "./package-shares.ts";
import { mayLandInPersonalSpace } from "./space-packages.ts";
import type { AppEnv } from "../types/index.ts";
import { callerPersonalOwnerId } from "../lib/view-as.ts";
import { listOrgOffers } from "./package-placement.ts";
import type { OrgOfferMode } from "@appstrate/db/schema";

/** Whether the space RUNS what it was placed. */
type PlacementState = "active" | "inactive" | "none";

/** One (package, space) cell of the library map. */
interface Placement {
  space_id: string;
  via: PlacementVia;
  state: PlacementState;
  /** Who placed it (`shared` only); `null` for a row a home move left or a gone account. */
  shared_by: { user_id: string; name: string } | null;
}

/**
 * Whether the caller may switch a package on/off in one space, as the
 * `…/packages` routes judge it: `not_offered` = a personal space, and the
 * package is neither its own, offered to the organization nor on by the
 * deployment's default (`mayLandInPersonalSpace`); `not_shareable` = not placed
 * there and no `<type>:share` in its home; `forbidden` = the `activate`/`deactivate` grant is
 * missing (a personal space's owner needs none); `runtime_bound` = a deactivate
 * of a system integration serving the run's own tools, which stays active
 * everywhere whatever the role.
 */
type ActivationVerdict =
  "allowed" | "not_offered" | "not_shareable" | "forbidden" | "runtime_bound";

/** The two verdicts of one (package, space) pair, for every space the library lists. */
interface ActivationCell {
  spaceId: string;
  activate: ActivationVerdict;
  deactivate: ActivationVerdict;
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
  /** The offer to the organization, placed in every space holding no row of its own: `on_by_default` is also active there, `available` waits for the space to switch it on. */
  org_offer: OrgOfferMode | null;
  /** Whether THIS caller may offer it or withdraw the offer (`PUT|DELETE …/org-offer`). */
  org_offerable: boolean;
  /** Active in every space by the deployment's default: an offer would change nothing. */
  active_by_default: boolean;
  placements: Placement[];
  activation: ActivationCell[];
}

/**
 * The library: a map of placements, one row per package and one `placements`
 * entry per readable space it is placed in. `via` says why it is there, `state`
 * whether the space runs it (`active`, `inactive` = row off, `none` = no row and
 * default off). `GET /api/library` spans every readable space;
 * `GET /api/spaces/{id}/library` narrows to one. A package with no placement is
 * still listed when the caller could place it (`<type>:share` in its home), but
 * never into a personal destination.
 */
export function getPackageLibrary(c: Context<AppEnv>, spaceId?: string) {
  return readPackageLibrary(c, spaceId);
}

/**
 * One package's detail read: the library narrowed to `packageId`, its placements judged under
 * `grant` — the permission the calling route checked (`integrations:configure` for the settings
 * PATCH, which does not imply `integrations:read`), in place of the type's read grant.
 */
type PackageDetailSelection = { packageId: string; grant: CorePermission };

async function readPackageLibrary(
  c: Context<AppEnv>,
  spaceId?: string,
  detail?: PackageDetailSelection,
) {
  const orgId = c.get("orgId");
  const packageIds = detail ? [detail.packageId] : undefined;

  const accessible = await packageAccessSpaces(c);
  // The caller's own personal space takes no activation grant: ownership authorizes
  // (`coarseSpacePackageGate`, `routes/spaces.ts`).
  const personalOwnerId = callerPersonalOwnerId(c);
  const runtimeBound = new Set(listRuntimeBoundSystemIntegrationIds());
  const activationVerdict = (
    pkg: ActivatablePackage & { homeSpaceId: string | null },
    space: (typeof accessible)[number],
    placed: boolean,
    shareable: boolean,
    next: boolean,
  ): ActivationVerdict => {
    const type = pkg.type as PackageType;
    if (!next && type === "integration" && runtimeBound.has(pkg.id)) return "runtime_bound";
    if (next && space.ownerUserId !== null && !mayLandInPersonalSpace(pkg, space.id)) {
      return "not_offered";
    }
    if (!placed && !shareable) return "not_shareable";
    const ownSpace = space.ownerUserId !== null && space.ownerUserId === personalOwnerId;
    if (ownSpace) return "allowed";
    return space.permissions.has(spacePackagePermission(type, next ? "activate" : "deactivate"))
      ? "allowed"
      : "forbidden";
  };
  const target = spaceId ? accessible.find((space) => space.id === spaceId) : undefined;
  // The spaces whose library this caller reads: those it reaches AND holds
  // `spaces:read` in — the per-space route's own guard, so the organization
  // form is exactly the union of the space forms (an owner or admin holds it
  // everywhere). The space form's route has already checked it for its space.
  const visibleSpaces = spaceId
    ? accessible.filter((space) => space.id === spaceId)
    : accessible.filter((space) => space.permissions.has("spaces:read"));
  const visibleIds = new Set(visibleSpaces.map((space) => space.id));
  const accessibleIds = accessible.map((space) => space.id);
  const orgSpaces = visibleSpaces
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
    .map(({ id, name, isDefault }) => ({ id, name, isDefault }));
  // A PERSONAL space is its owner's: nobody places a package there on their
  // behalf, so it never makes an unplaced package a candidate (below). What the
  // space RUNS is not narrowed here: a system package is placed in every space,
  // personal ones included, and its `state` is the activation rule's answer.
  // What it may switch on is the `activate` verdict (`not_offered`).
  const personalSpaceIds = new Set(
    accessible.filter((space) => space.ownerUserId !== null).map((space) => space.id),
  );
  // Per type, the spaces whose placements this caller may see at all: read
  // permission for that type, and — in the space form — the requested space
  // alone. A personal target additionally hides every other space, since its
  // page is its owner's and nobody else's.
  const readableSpaceIds = new Map<PackageType, Set<string>>(
    packageTypeValues.map((type) => [
      type,
      new Set(
        accessible
          .filter(
            (space) =>
              (!target?.ownerUserId || space.id === target.id) &&
              visibleIds.has(space.id) &&
              space.permissions.has(detail?.grant ?? packagePermission(type, "read")),
          )
          .map((space) => space.id),
      ),
    ]),
  );

  // One read for the map. The sharer is named only while still an org member:
  // the membership join is the filter (see `sharerView`).
  const rows = await db
    .select({
      id: packages.id,
      type: packages.type,
      source: packages.source,
      homeSpaceId: packages.homeSpaceId,
      draftManifest: packages.draftManifest,
      spaceId: spacePackages.spaceId,
      enabled: spacePackages.enabled,
      placedByOffer: spacePackages.placedByOffer,
      sharedBy: spacePackages.sharedBy,
      sharerName: user.name,
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
    .leftJoin(
      organizationMembers,
      and(
        eq(organizationMembers.userId, spacePackages.sharedBy),
        eq(organizationMembers.orgId, orgId),
      ),
    )
    .leftJoin(user, eq(user.id, organizationMembers.userId))
    .where(
      and(
        orgOrSystemFilter(orgId),
        notEphemeralFilter(),
        detail ? eq(packages.id, detail.packageId) : undefined,
      ),
    )
    .orderBy(packages.id);

  const orgOffers = await listOrgOffers(orgId, packageIds);

  /** packageId → spaceId → the row's switches, for the rows the caller's spaces hold. */
  const placementRows = new Map<
    string,
    Map<
      string,
      {
        enabled: boolean;
        placedByOffer: boolean;
        sharedBy: { user_id: string; name: string } | null;
      }
    >
  >();
  for (const row of rows) {
    if (!row.spaceId) continue;
    let bySpace = placementRows.get(row.id);
    if (!bySpace) placementRows.set(row.id, (bySpace = new Map()));
    bySpace.set(row.spaceId, {
      enabled: row.enabled!,
      placedByOffer: row.placedByOffer!,
      sharedBy: sharerView(row),
    });
  }

  // One row per package: the join above repeats a package once per placement
  // row, and the projection below reads the whole map at once.
  const catalogue = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!catalogue.has(row.id)) catalogue.set(row.id, row);

  // The offer door's version precondition, for every homed package at once.
  const homedIds = [...catalogue.values()]
    .filter((row) => row.source !== "system")
    .map((r) => r.id);
  const published = new Set(
    homedIds.length === 0
      ? []
      : (
          await db
            .select({ packageId: packageDistTags.packageId })
            .from(packageDistTags)
            .where(
              and(eq(packageDistTags.tag, "latest"), inArray(packageDistTags.packageId, homedIds)),
            )
        ).map((tag) => tag.packageId),
  );

  const grouped: Record<string, LibraryPackage[]> = {
    agent: [],
    skill: [],
    integration: [],
  };

  for (const row of catalogue.values()) {
    const type = row.type as PackageType;
    const readable = readableSpaceIds.get(type);
    if (!readable?.size) continue;
    const home = homeWireForCaller(row, accessible);
    const rowsBySpace = placementRows.get(row.id);

    const orgOffer = orgOffers.get(row.id) ?? null;
    const activeByDefault = isActiveEverywhereByDefault({ id: row.id, type, source: row.source });
    const offered = { ...row, type, orgOffer };
    const placements: Placement[] = [];
    for (const space of readable) {
      const placementRow = rowsBySpace?.get(space);
      const via = placementVia(offered, space, placementRow);
      if (via === null) continue;
      placements.push({
        space_id: space,
        via,
        state: placementState(offered, placementRow?.enabled),
        shared_by: via === "shared" ? (placementRow?.sharedBy ?? null) : null,
      });
    }
    placements.sort((a, b) => a.space_id.localeCompare(b.space_id));

    // Unplaced packages are listed only as candidates the caller could place
    // (`<type>:share` in the home), never into a personal destination alone.
    const proposable = [...readable].some((space) => !personalSpaceIds.has(space));
    if (placements.length === 0 && !(proposable && home.home_shareable)) continue;

    const placedIn = new Set(placements.map((placement) => placement.space_id));
    const activation = visibleSpaces.map((space): ActivationCell => ({
      spaceId: space.id,
      activate: activationVerdict(
        offered,
        space,
        placedIn.has(space.id),
        home.home_shareable,
        true,
      ),
      deactivate: activationVerdict(
        offered,
        space,
        placedIn.has(space.id),
        home.home_shareable,
        false,
      ),
    }));

    const m = asRecord(row.draftManifest);
    grouped[row.type]?.push({
      id: row.id,
      type: row.type,
      source: row.source,
      // ONE contract for the home group, computed server-side (RBAC spec §6.9,
      // §6.10): the home's id only when this caller reaches that space, and the
      // write, delete and share verdicts themselves.
      ...home,
      org_offer: orgOffer,
      // The offer door's verdict (`assertPackageOfferAccess`): the role and ceiling, the home's
      // `share` (`home_shareable`) and, when creating an offer for a homed package, a published
      // version; a system package already active by default takes no new offer.
      org_offerable:
        callerMayOffer(c, type) &&
        (row.source === "system"
          ? orgOffer !== null || !activeByDefault
          : home.home_shareable && (orgOffer !== null || published.has(row.id))),
      active_by_default: activeByDefault,
      name: typeof m.display_name === "string" ? m.display_name : row.id,
      description: typeof m.description === "string" ? m.description : "",
      placements,
      activation,
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
 * at all.
 */
function placementState(
  pkg: { id: string; type: PackageType; source: string; orgOffer: OrgOfferMode | null },
  enabled: boolean | undefined,
): PlacementState {
  const row = enabled === undefined ? undefined : { enabled };
  return isActiveHere(pkg, row) ? "active" : row ? "inactive" : "none";
}

/**
 * What the library says about ONE package in ONE space, for every package type — a projection of
 * {@link getPackageLibrary}, never a second computation. A package the library does not place
 * there for this caller is a 404, like the detail route's own placement check.
 */
export async function packageAvailabilityIn(
  c: Context<AppEnv>,
  packageId: string,
  spaceId: string,
  grant: CorePermission,
) {
  const library = await readPackageLibrary(c, spaceId, { packageId, grant });
  const entry = Object.values(library.packages).flat()[0];
  const placement = entry?.placements.find((p) => p.space_id === spaceId);
  if (!entry || !placement) {
    throw notFound(`Package '${packageId}' not found in this organization`);
  }
  const { space_id: _space, ...here } = placement;
  return {
    ...here,
    org_offer: entry.org_offer,
    org_offerable: entry.org_offerable,
    active_by_default: entry.active_by_default,
  };
}
