// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue's addresses: `/catalogue/:reading/:type`. Links open on Découvrir,
 * and given a package on that package's sheet.
 */

import type { PackageType } from "@appstrate/core/validation";

/** The route's `:reading` segment. */
const CATALOGUE_READINGS = ["placed", "discover"] as const;
export type CatalogueReading = (typeof CATALOGUE_READINGS)[number];

export function isCatalogueReading(value: string): value is CatalogueReading {
  return (CATALOGUE_READINGS as readonly string[]).includes(value);
}

/** The route's `:type` segment, in the rail's order.  */
export const CATALOGUE_KINDS = [
  "agent",
  "skill",
  "mcp-server",
  "integration",
] as const satisfies readonly PackageType[];

export function isCatalogueKind(value: string): value is PackageType {
  return (CATALOGUE_KINDS as readonly string[]).includes(value);
}

/** Spelled out so the locale test sees every key. */
export const CATALOGUE_TYPE_LABEL_KEY: Record<PackageType, string> = {
  agent: "integration.admin.pinManagement.colAgent",
  skill: "catalogue.sheet.type.skill",
  integration: "connections.kindIntegration",
  "mcp-server": "catalogue.sheet.type.mcp-server",
};

/** The sheet's package, and the published version it is read at (`?package=…&version=…`). */
export const CATALOGUE_PACKAGE_PARAM = "package";
export const CATALOGUE_VERSION_PARAM = "version";

/**
 * `version` only means something beside a `packageId`: the sheet reads that
 * published version of the package instead of the one the reader would see.
 */
export function catalogueHref(
  type: PackageType,
  options: { packageId?: string; version?: string } = {},
): string {
  const base = `/catalogue/discover/${type}`;
  if (!options.packageId) return base;
  const query = new URLSearchParams({ [CATALOGUE_PACKAGE_PARAM]: options.packageId });
  if (options.version) query.set(CATALOGUE_VERSION_PARAM, options.version);
  return `${base}?${query.toString().replace(/\+/g, "%20")}`;
}

/**
 * The version a package page asks the catalogue to open, or `undefined` for the
 * package as the reader sees it. Only a version the reader CHOSE is pinned (the
 * page's `/:version` route): the live page follows whatever is current, and so
 * must its link, or it would go stale at the next publication. A system package
 * ships one definition and answers no version.
 */
export function catalogueVersionFor(page: {
  isHistoricalVersion: boolean;
  source: string | undefined;
  version: string | null | undefined;
}): string | undefined {
  if (!page.isHistoricalVersion || page.source === "system") return undefined;
  return page.version || undefined;
}
