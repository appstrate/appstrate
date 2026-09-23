// SPDX-License-Identifier: Apache-2.0

/**
 * Where "Parcourir le catalogue" goes, from wherever it is offered.
 *
 * It opens on Découvrir, the reading that answers "what else exists, and does
 * my space run it" — which is what a page belonging to a space asks. It used to
 * narrow to that space; the catalogue no longer narrows, since the reader's own
 * space leads every table and ticks every card.
 *
 * Given a package, it opens that package's sheet: a notification about ONE
 * share is answered on that package, not in a list the reader has to search.
 */

import type { PackageType } from "@appstrate/core/validation";

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
