// SPDX-License-Identifier: Apache-2.0

/**
 * "Is this package ACTIVE in this space?" — THE definition, stated twice and
 * nowhere else: once as a SQL expression for the queries that filter or project
 * it, once as a pure in-memory predicate for the callers that already hold the
 * rows.
 *
 *   activeHere = the placement row's `enabled`, when there IS a row
 *              = the deployment's default OR an offer to the space's
 *                organization (`org_package_offers`), when there is none
 *
 * The ROW ALWAYS WINS. That is why a system package can be switched off per
 * space like any other: an explicit `false` is an operator decision the
 * platform must not overrule, and the row survives every run, so the opt-out
 * is sticky. A row is a placement of its own (`placementReadFilter`,
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
import type { PackageType } from "@appstrate/core/validation";
import { listSystemIntegrationIds } from "./integration-client-registry.ts";
import { listRuntimeBoundSystemIntegrationIds } from "./system-packages.ts";
import { offeredToSpaceOrgSql } from "./package-placement.ts";

/** The catalog columns the rule reads — every caller already has them. */
export interface ActivatablePackage {
  id: string;
  type: PackageType | string;
  source: string | null;
  /** Offered to the organization of the space asked about (`org_package_offers`). */
  offeredToOrg: boolean;
}

/** The integration ids active without a row: the offered ones and the runtime-bound ones. */
function activeWithoutRowIntegrationIds(): ReadonlySet<string> {
  return new Set([...listSystemIntegrationIds(), ...listRuntimeBoundSystemIntegrationIds()]);
}

/**
 * Is the package active in a space that holds NO placement row for it?
 *
 * The deployment's default or the organization's offer: the half of the rule
 * that looks at the package rather than at the space's decision.
 */
export function isActiveWithoutRow(pkg: ActivatablePackage): boolean {
  if (pkg.offeredToOrg) return true;
  if (pkg.type === "integration") return activeWithoutRowIntegrationIds().has(pkg.id);
  return pkg.source === "system";
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
 * The rule, in SQL. Expects a LEFT JOIN of `spacePackages` on (package, the
 * space asked about) — `placementRowJoin` (`services/package-placement.ts`) —
 * and takes that same space as `spaceId` (a value, or a column of the outer
 * query), against which the organization's offer is read. A query that omits it loses the row half silently rather than loudly: every
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
    and(isNull(spacePackages.packageId), or(systemDefault, offeredToSpaceOrgSql(spaceId))),
  );
}
