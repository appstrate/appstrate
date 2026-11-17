// SPDX-License-Identifier: Apache-2.0

/**
 * Which sidebar entry is the page's. The header trail already says where a page sits — a run of
 * an agent under « Agents », an inline run under « Tous les runs » — so the sidebar reads the
 * SAME answer: the trail's root when it links somewhere, else the page's own path (a list page
 * is the root of its trail). Behind an open overlay the page is not where the reader is, and
 * nothing is active (`overlayPath`).
 */

import { isUnder } from "./route-access";

/** Where the page sits for the sidebar: the overlay's path, else the trail's root, else the address. */
export function navLocation(input: {
  overlayPath: string | null;
  trailRootHref: string | undefined;
  pathname: string;
}): string {
  // The root crumb may carry a hash (`/agents/x#runs`) or a query: only its path names an entry.
  const root = input.trailRootHref?.split(/[?#]/)[0];
  return input.overlayPath ?? (root || input.pathname);
}

/** Whether the entry at `path` is active where the page sits (`navLocation`): the dashboard exactly, any other entry with its sub-pages. */
export function navEntryActive(path: string, location: string): boolean {
  return path === "/" ? location === "/" : isUnder(location, path);
}
