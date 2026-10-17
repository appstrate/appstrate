// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  organizationMembers,
  packageDistTags,
  packages,
  spacePackages,
  user,
} from "@appstrate/db/schema";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import { asRecord } from "@appstrate/core/safe-json";
import { packagePermission, spacePackagePermission } from "@appstrate/core/permissions";
import { homeWireForCaller, packageAccessSpaces } from "../lib/package-access.ts";
import { isActiveHere } from "./package-activation.ts";
import { isPublished, latestTagJoin } from "./space-packages.ts";
import { sharerView } from "./package-shares.ts";
import type { PackageType } from "@appstrate/core/validation";
import type { AppEnv } from "../types/index.ts";
import { callerPersonalOwnerId } from "../lib/view-as.ts";

const PACKAGE_TYPES = ["agent", "skill", "mcp-server", "integration"] as const;

/** How a package reaches a space: its home, a row outside it (`shared`), or `system` (RBAC spec §6.9). */
type PlacementVia = "home" | "shared" | "system";

/** Whether the space RUNS what it was placed. */
type PlacementState = "active" | "inactive" | "none";

/** One (package, space) cell of the library map. */
interface Placement {
  space_id: string;
  via: PlacementVia;
  state: PlacementState;
  /** Whether this space enforces the skill in its chat; `false` with no row. */
  chat_enforced: boolean;
  /** Who placed it (`shared` only); `null` for a row a home move left or a gone account. */
  shared_by: { user_id: string; name: string } | null;
}

/**
 * Whether the caller may switch a package on/off in one space, as the
 * `…/packages` routes judge it: `not_shareable` = not placed there and no
 * `<type>:share` in its home; `forbidden` = the `activate`/`deactivate` grant is
 * missing (a personal space's owner needs none).
 */
type ActivationVerdict = "allowed" | "not_shareable" | "forbidden";

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
  /** A `latest` published version exists (or a system package) — what enforcing a skill needs. */
  published: boolean;
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
export async function getPackageLibrary(c: Context<AppEnv>, spaceId?: string) {
  const orgId = c.get("orgId");

  const accessible = await packageAccessSpaces(c);
  // The caller's own personal space takes no activation grant: ownership authorizes
  // (`coarseSpacePackageGate`, `routes/spaces.ts`).
  const personalOwnerId = callerPersonalOwnerId(c);
  const activationVerdict = (
    type: PackageType,
    space: (typeof accessible)[number],
    placed: boolean,
    shareable: boolean,
    next: boolean,
  ): ActivationVerdict => {
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
              visibleIds.has(space.id) &&
              space.permissions.has(packagePermission(type, "read")),
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
      latestVersionId: packageDistTags.versionId,
      spaceId: spacePackages.spaceId,
      enabled: spacePackages.enabled,
      chatEnforced: spacePackages.chatEnforced,
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
    .leftJoin(packageDistTags, latestTagJoin(packages.id))
    .where(and(orgOrSystemFilter(orgId), notEphemeralFilter()))
    .orderBy(packages.id);

  /** packageId → spaceId → the row's switches, for the rows the caller's spaces hold. */
  const placementRows = new Map<
    string,
    Map<
      string,
      {
        enabled: boolean;
        chatEnforced: boolean;
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
      chatEnforced: row.chatEnforced!,
      sharedBy: sharerView(row),
    });
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
            : placementRow
              ? "shared"
              : null;
      if (via === null) continue;
      placements.push({
        space_id: space,
        via,
        state: placementState({ id: row.id, type, source: row.source }, placementRow?.enabled),
        chat_enforced: placementRow?.chatEnforced ?? false,
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
      activate: activationVerdict(type, space, placedIn.has(space.id), home.home_shareable, true),
      deactivate: activationVerdict(
        type,
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
      name: typeof m.display_name === "string" ? m.display_name : row.id,
      description: typeof m.description === "string" ? m.description : "",
      published: isPublished(row),
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
  pkg: { id: string; type: PackageType; source: string },
  enabled: boolean | undefined,
): PlacementState {
  const row = enabled === undefined ? undefined : { enabled };
  return isActiveHere(pkg, row) ? "active" : row ? "inactive" : "none";
}
