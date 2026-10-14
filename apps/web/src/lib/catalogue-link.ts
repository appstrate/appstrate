// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue's addresses: `/catalogue/:reading/:type`.
 *
 * "Parcourir le catalogue" opens on Découvrir, the reading that answers "what
 * else exists, and does my space run it" — which is what a page belonging to a
 * space asks. It does not narrow to that space: the reader's own space leads
 * every table and ticks every card. Given a package, it opens that package's
 * sheet: a notification about ONE share is answered on that package, not in a
 * list the reader has to search.
 */

import type { PackageType } from "@appstrate/core/validation";

/**
 * The catalogue's READINGS of one set, the route's `:reading` segment:
 * `discover` browses every package in cards, `placed` manages what the reader's
 * spaces hold, space by space, and `shared` lists the shares waiting. Provenance
 * is a filter, not a reading: a reader wants to know what they already have
 * before knowing who made it.
 */
const CATALOGUE_READINGS = ["placed", "discover", "shared"] as const;
export type CatalogueReading = (typeof CATALOGUE_READINGS)[number];

export function isCatalogueReading(value: string): value is CatalogueReading {
  return (CATALOGUE_READINGS as readonly string[]).includes(value);
}

/**
 * The kinds, in the rail's order — the route's `:type` segment. Every reading
 * names one, `shared` included: it is the kind the rail returns to, so every
 * catalogue address has one shape.
 */
export const CATALOGUE_KINDS = [
  "agent",
  "skill",
  "mcp-server",
  "integration",
] as const satisfies readonly PackageType[];

export function isCatalogueKind(value: string): value is PackageType {
  return (CATALOGUE_KINDS as readonly string[]).includes(value);
}

/** A kind's name in one word (`settings` namespace), spelled out so the locale test sees every key. */
export const CATALOGUE_TYPE_LABEL_KEY: Record<PackageType, string> = {
  agent: "catalogue.sheet.type.agent",
  skill: "catalogue.sheet.type.skill",
  integration: "catalogue.sheet.type.integration",
  "mcp-server": "catalogue.sheet.type.mcp-server",
};

export function catalogueHref(type: PackageType, options: { packageId?: string } = {}): string {
  const base = `/catalogue/discover/${type}`;
  return options.packageId ? `${base}?package=${encodeURIComponent(options.packageId)}` : base;
}

/** "Partages en attente": every share waiting, across kinds. */
export const CATALOGUE_SHARED_HREF = `/catalogue/shared/${CATALOGUE_KINDS[0]}`;
