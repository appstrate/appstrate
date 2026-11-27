// SPDX-License-Identifier: Apache-2.0

/**
 * "Is this package ACTIVE in this space?" — THE definition, stated twice and
 * nowhere else: once as a SQL expression for the queries that filter or project
 * it, once as a pure in-memory predicate for the callers that already hold the
 * rows. Where a placement comes FROM ({@link placementVia}) is stated here too,
 * once.
 *
 *   activeHere = the placement row's `enabled`, when there IS a row
 *              = the deployment's default OR an `on_by_default` offer to the
 *                space's organization (`org_package_offers`), when there is none
 *
 * An offer in either mode PLACES the package in every space of the
 * organization; only `on_by_default` also activates it. An `available` offer
 * leaves the package placed and off until the space switches it on.
 *
 * The ROW ALWAYS WINS. That is why a system package can be switched off per
 * space like any other: an explicit `false` is an operator decision the
 * platform must not overrule, and the row survives every run, so the opt-out
 * is sticky. The one exception is a runtime-bound system integration: it
 * serves the run's own tools, so `deactivatePackage` refuses it. A row is a placement of its own (`placementReadFilter`,
 * `services/package-placement.ts`), so no placement conjunct is needed: a
 * package placed outside its home with `enabled = false` is placed and off.
 *
 * The default WITHOUT a row only ever switches on packages the deployment
 * ships, which are placed everywhere by construction. It is
 * `source = 'system'`, with one narrowing for integrations: the deployment
 * ships dozens of integration packages and OFFERS only the subset
 * `SYSTEM_INTEGRATIONS` names ({@link listSystemIntegrationIds}); the rest are
 * catalog entries a space activates deliberately. Reading `source` alone there
 * would switch the whole catalog on in every space. The system integrations
 * bound to the runtime ({@link listRuntimeBoundSystemIntegrationIds}) are
 * offered too: they serve the run's own tools.
 *
 * The two forms are twins, not two rules: a table-driven test
 * (`package-activation-parity.test.ts`) walks every (type × source × row) cell
 * and asserts they answer the same. Everything else PROJECTS one of them — the
 * library's `state` (`package-library.ts`) calls {@link isActiveHere} — so
 * there is no third copy to drift.
 */

import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { packages, spacePackages } from "@appstrate/db/schema";
import type { OrgOfferMode } from "@appstrate/db/schema";
import type { PackageType } from "@appstrate/core/validation";
import { listSystemIntegrationIds } from "./integration-client-registry.ts";
import { listRuntimeBoundSystemIntegrationIds } from "./system-packages.ts";
import { offeredToSpaceOrgSql } from "./package-placement.ts";

/** The catalog columns the rule reads — every caller already has them. */
export interface ActivatablePackage {
  id: string;
  type: PackageType | string;
  source: string | null;
  /** The mode of the offer to the organization of the space asked about (`org_package_offers`), or `null` when there is none. */
  orgOffer: OrgOfferMode | null;
}

/** The integration ids active without a row: the offered ones and the runtime-bound ones. */
function activeWithoutRowIntegrationIds(): ReadonlySet<string> {
  return new Set([...listSystemIntegrationIds(), ...listRuntimeBoundSystemIntegrationIds()]);
}

/**
 * Is the package active in a space with no row and no offer: the deployment's
 * default alone? An offer to it would change nothing.
 */
export function isActiveByDefault(pkg: Omit<ActivatablePackage, "orgOffer">): boolean {
  if (pkg.type === "integration") return activeWithoutRowIntegrationIds().has(pkg.id);
  return pkg.source === "system";
}

/**
 * Does the deployment alone make the package run in EVERY space: shipped by the
 * platform (`source = 'system'`, placed everywhere) AND active by default? An
 * integration the organization published and `SYSTEM_INTEGRATIONS` names is
 * active-without-row by {@link isActiveByDefault} but placed only where it is
 * homed or shared, so an offer still changes something for it.
 */
export function isActiveEverywhereByDefault(pkg: Omit<ActivatablePackage, "orgOffer">): boolean {
  return pkg.source === "system" && isActiveByDefault(pkg);
}

/**
 * Is the package active in a space that holds NO placement row for it?
 *
 * The deployment's default or an `on_by_default` offer: the half of the rule
 * that looks at the package rather than at the space's decision.
 */
export function isActiveWithoutRow(pkg: ActivatablePackage): boolean {
  return pkg.orgOffer === "on_by_default" || isActiveByDefault(pkg);
}

/**
 * The rule, in memory. `row` is the space's placement row, or `undefined` when
 * the space has none.
 */
export function isActiveHere(
  pkg: ActivatablePackage,
  row: { enabled: boolean } | null | undefined,
): boolean {
  return row ? row.enabled : isActiveWithoutRow(pkg);
}

/**
 * How a package reaches a space: `system`, its home, a row outside it
 * (`shared`), or an offer to the organization with no row of the space's own
 * (`organization`). A system integration activated solely by the offer also
 * reports `organization` (§6.8).
 */
export type PlacementVia = "home" | "shared" | "system" | "organization";

/**
 * Where a package's presence in a space comes from, or `null` when it is not
 * placed there. `row` is the space's placement row, or `undefined` when it has
 * none; `pkg.orgOffer` is the offer to that space's organization, in either
 * mode. A row an offer no longer explains (withdrawn) is a row outside the
 * home: `shared`, as `placementReadFilter` reads it. A system package reports `system` unless the
 * offer is what activates it and the space holds no row, or only an offer row.
 */
export function placementVia(
  pkg: ActivatablePackage & { homeSpaceId: string | null },
  spaceId: string,
  row: { placedByOffer: boolean } | null | undefined,
): PlacementVia | null {
  const offered = pkg.orgOffer !== null;
  const activatedByOffer = offered && !isActiveByDefault(pkg);
  // A system package the offer alone activates is `organization`, with no row or only an offer row.
  const offerDecides = activatedByOffer && (!row || row.placedByOffer);
  if (pkg.source === "system" && !offerDecides) return "system";
  if (pkg.homeSpaceId === spaceId) return "home";
  if (row && (!row.placedByOffer || !offered)) return "shared";
  return offered ? "organization" : null;
}

/**
 * The rule, in SQL. Expects a LEFT JOIN of `spacePackages` on (package, the
 * space asked about) — `placementRowJoin` (`services/package-placement.ts`) —
 * and takes that same space as `spaceId` (a value, or a column of the outer
 * query), against which the organization's `on_by_default` offer is read. A query that omits it loses the row half silently rather than loudly: every
 * package falls back to the deployment default, which is not the same question.
 *
 * The `IN (…)` list is the system-integration registry, read from memory at
 * query-build time: it is a boot-time env constant (a handful of ids), so
 * inlining it costs nothing and keeps the default identical to the in-memory
 * twin instead of approximating it with `source = 'system'`.
 */
export function activeHereSql(spaceId: string | AnyPgColumn) {
  const offered = [...activeWithoutRowIntegrationIds()];
  const systemDefault = or(
    and(ne(packages.type, "integration"), eq(packages.source, "system")),
    and(
      eq(packages.type, "integration"),
      offered.length > 0 ? inArray(packages.id, offered) : sql`false`,
    ),
  );
  return or(
    and(isNotNull(spacePackages.packageId), eq(spacePackages.enabled, true)),
    and(
      isNull(spacePackages.packageId),
      or(systemDefault, offeredToSpaceOrgSql(spaceId, "on_by_default")),
    ),
  );
}
