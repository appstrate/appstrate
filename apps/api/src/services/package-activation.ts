// SPDX-License-Identifier: Apache-2.0

/**
 * "Is this package ACTIVE in this space?" — THE definition, stated twice and
 * nowhere else: once as a SQL expression for the queries that filter or project
 * it, once as a pure in-memory predicate for the callers that already hold the
 * rows.
 *
 *   activeHere = the placement row's `enabled` AND the package is PLACED here,
 *                  when there IS a row
 *              = the deployment's default, when there is none
 *
 * The ROW ALWAYS WINS, WHERE THE PACKAGE IS PLACED. The first half is why a
 * system package can be switched off per space like any other: an explicit
 * `false` is an operator decision the platform must not overrule, and a switch
 * that changes nothing is worse than no switch at all. It is also what makes
 * the opt-out sticky — the row survives every run, so nothing silently
 * switches the package back on.
 *
 * The second half is what keeps a row from being a placement of its own
 * ({@link placementReadFilter}, `services/package-placement.ts`). An ORPHAN
 * row — one with neither a home nor a share behind it, the residue
 * `scripts/migration/0016` repairs — is a decision about a package the space
 * no longer holds, and it must not read as "on" ANYWHERE: not in the caller
 * context handed to the model, not on a type's index page, not on the run
 * gate, not on the space-package reads. A rule that answered "active" there
 * would let a space run, and see the draft of, a package every placement-aware
 * page correctly refuses to show it.
 *
 * The default WITHOUT a row needs no placement conjunct: it only ever switches
 * on packages the deployment ships, and those are placed in every space by
 * construction.
 *
 * The default WITHOUT a row is `source = 'system'`, with one narrowing that
 * belongs to integrations alone: the deployment ships ~65 integration packages
 * and OFFERS the subset named by `SYSTEM_INTEGRATIONS` ({@link
 * isSystemIntegration}). Only those are on out of the box; the rest are catalog
 * entries a space activates deliberately, exactly like an org-authored one.
 * Reading `source` alone there would switch the whole catalog on in every
 * space.
 *
 * The two forms are twins, not two rules: a table-driven test
 * (`package-activation-parity.test.ts`) walks every (type × source × row ×
 * placed) cell and asserts they answer the same.
 *
 * Everything else PROJECTS one of the two rather than restating it — the
 * library's `state` (`package-library.ts`) calls {@link isActiveHere} and only
 * names WHY the answer was no (`inactive` a row saying `false`, `none` no row
 * at all), so there is no third copy to drift.
 */

import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { packages, spacePackages } from "@appstrate/db/schema";
import type { PackageType } from "@appstrate/core/validation";
import { isSystemIntegration, listSystemIntegrationIds } from "./integration-client-registry.ts";
import { placementReadFilter } from "./package-placement.ts";

/** The catalog columns the rule reads — every caller already has them. */
export interface ActivatablePackage {
  id: string;
  type: PackageType | string;
  source: string | null;
}

/**
 * Is the package active in a space that holds NO placement row for it?
 *
 * The deployment's default, and the only half of the rule that looks at the
 * package rather than at the space's decision.
 */
export function isActiveWithoutRow(pkg: ActivatablePackage): boolean {
  if (pkg.type === "integration") return isSystemIntegration(pkg.id);
  return pkg.source === "system";
}

/**
 * The rule, in memory. `row` is the space's placement row, or `undefined` when
 * the space has none; `placed` is the placement verdict for the same space —
 * homed there, offered there, or shipped with the deployment.
 *
 * `placed` is only ever read alongside a row, and that asymmetry is the rule
 * rather than an optimization: the deployment's default switches on nothing
 * that is not placed everywhere, while a row is a decision a space made about
 * a package it may since have lost. A caller that cannot answer the placement
 * question has no business answering this one — it would be reading a row the
 * space is not entitled to act on.
 */
export function isActiveHere(
  pkg: ActivatablePackage,
  row: { enabled: boolean } | null | undefined,
  placed: boolean,
): boolean {
  return row ? row.enabled && placed : isActiveWithoutRow(pkg);
}

/**
 * The rule, in SQL. Expects TWO LEFT JOINs on `spaceId`, and states both
 * because a query that omits either loses a half silently rather than loudly:
 *
 *   - `spacePackages` on (package, `spaceId`) — without it the row half is
 *     always NULL and every package falls back to the deployment default,
 *     which is not the same question;
 *   - `packageShares` on (package, `spaceId`) — the share half of
 *     {@link placementReadFilter}, without which every offered package reads
 *     as unplaced and its row stops counting.
 *
 * The placement conjunct rides on the ROW branch only, for the reason the
 * module docstring gives: an orphan row decides nothing, and the default
 * decides only for packages placed everywhere by construction.
 *
 * The `IN (…)` list is the system-integration registry, read from memory at
 * query-build time: it is a boot-time env constant (a handful of ids), so
 * inlining it costs nothing and keeps the default identical to the in-memory
 * twin instead of approximating it with `source = 'system'`.
 */
export function activeHereSql(spaceId: string) {
  const offered = listSystemIntegrationIds();
  const systemDefault = or(
    and(ne(packages.type, "integration"), eq(packages.source, "system")),
    and(
      eq(packages.type, "integration"),
      offered.length > 0 ? inArray(packages.id, offered) : sql`false`,
    ),
  );
  return or(
    and(
      isNotNull(spacePackages.packageId),
      eq(spacePackages.enabled, true),
      placementReadFilter(spaceId),
    ),
    and(isNull(spacePackages.packageId), systemDefault),
  );
}
