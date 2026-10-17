// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue's addresses: `/catalogue/:type`, the kind, and the view in the
 * query. Links open on Découvrir, and given a package on that package's sheet.
 */

import type { PackageType } from "@appstrate/core/validation";
import { searchOf } from "./url-search";

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
const CATALOGUE_PACKAGE_PARAM = "package";
export const CATALOGUE_VERSION_PARAM = "version";

/**
 * One set seen two ways: Découvrir's cards, or the table of where each package is
 * placed (`?view=spaces`). Découvrir is the param's absence, so each view has one address.
 */
export type CatalogueView = "discover" | "spaces";
const CATALOGUE_VIEW_PARAM = "view";

/** The view an address asks for, or `null` for one the catalogue does not have. */
export function catalogueViewOf(search: string): CatalogueView | null {
  const value = new URLSearchParams(search).get(CATALOGUE_VIEW_PARAM);
  if (value === null) return "discover";
  return value === "spaces" ? value : null;
}

/**
 * `version` only means something beside a `packageId`: the sheet reads that
 * published version of the package instead of the one the reader would see.
 */
export function catalogueHref(
  type: PackageType,
  options: { packageId?: string; version?: string } = {},
): string {
  const base = cataloguePath(type);
  if (!options.packageId) return base;
  const query = new URLSearchParams({ [CATALOGUE_PACKAGE_PARAM]: options.packageId });
  if (options.version) query.set(CATALOGUE_VERSION_PARAM, options.version);
  return `${base}?${query.toString().replace(/\+/g, "%20")}`;
}

function cataloguePath(type: PackageType): string {
  return `/catalogue/${type}`;
}

/** A kind's address, keeping the current query (the view, the sheet's `package`, `version`) and hash. */
export function catalogueKindAddress(
  type: PackageType,
  from: { search: string; hash: string },
): string {
  return `${cataloguePath(type)}${from.search}${from.hash}`;
}

/** Where the address must move for a package's sheet to open on its own kind, or `null` when it already can. */
export function catalogueSheetAddress(
  active: PackageType,
  target: PackageType | undefined,
  from: { search: string; hash: string },
): string | null {
  if (target === undefined || target === active) return null;
  return catalogueKindAddress(target, from);
}

/**
 * The list of a kind in a view, as the rail and the view switch link to it: the
 * sheet closes, search and filters stay, except the state filter, which only the
 * per-space table has, when the view changes.
 */
export function catalogueListAddress(
  type: PackageType,
  view: CatalogueView,
  search: string,
): string {
  const query = new URLSearchParams(search);
  query.delete(CATALOGUE_PACKAGE_PARAM);
  query.delete(CATALOGUE_VERSION_PARAM);
  if (view !== catalogueViewOf(search)) query.delete("state");
  if (view === "discover") query.delete(CATALOGUE_VIEW_PARAM);
  else query.set(CATALOGUE_VIEW_PARAM, view);
  return `${cataloguePath(type)}${searchOf(query)}`;
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
