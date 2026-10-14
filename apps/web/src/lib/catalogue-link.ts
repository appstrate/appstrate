// SPDX-License-Identifier: Apache-2.0

/**
 * Where "Parcourir le catalogue" goes, from wherever it is offered.
 *
 * It opens on Découvrir, the reading that answers "what else exists, and does
 * my space run it" — which is what a page belonging to a space asks. It does
 * not narrow to that space: the reader's own space leads every table and ticks
 * every card.
 *
 * Given a package, it opens that package's sheet: a notification about ONE
 * share is answered on that package, not in a list the reader has to search.
 */

import type { PackageType } from "@appstrate/core/validation";

/**
 * The catalogue's READINGS of one set, the route's `:origin` segment: `discover`
 * browses every package in cards, `placed` manages what the reader's spaces
 * hold, space by space, and `shared` lists the shares waiting. Provenance is a
 * filter, not a reading: a reader wants to know what they already have before
 * knowing who made it.
 */
const CATALOGUE_SCOPES = ["placed", "discover", "shared"] as const;
export type CatalogueScope = (typeof CATALOGUE_SCOPES)[number];

export function isCatalogueScope(value: string): value is CatalogueScope {
  return (CATALOGUE_SCOPES as readonly string[]).includes(value);
}

export function catalogueHref(type: PackageType, options: { packageId?: string } = {}): string {
  // MCP servers have no tab of their own: they are integrations run locally.
  const kind = type === "mcp-server" ? "integration" : type;
  const base = `/catalogue/discover/${kind}`;
  return options.packageId ? `${base}?package=${encodeURIComponent(options.packageId)}` : base;
}

/**
 * "Partages en attente": every share waiting, across kinds. The route's `type`
 * segment carries no kind here — the list holds them all.
 */
export const CATALOGUE_SHARED_HREF = "/catalogue/shared/all";
