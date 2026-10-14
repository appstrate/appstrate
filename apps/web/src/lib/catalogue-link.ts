// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue's addresses: `/catalogue/:reading/:type`. Links open on Découvrir,
 * and given a package on that package's sheet.
 */

import type { PackageType } from "@appstrate/core/validation";

/**
 * The route's `:reading` segment: `discover` browses every package, `placed` manages
 * what the reader's spaces hold, `shared` lists the shares waiting.
 */
const CATALOGUE_READINGS = ["placed", "discover", "shared"] as const;
export type CatalogueReading = (typeof CATALOGUE_READINGS)[number];

export function isCatalogueReading(value: string): value is CatalogueReading {
  return (CATALOGUE_READINGS as readonly string[]).includes(value);
}

/** The route's `:type` segment, in the rail's order. Every reading names one, `shared` included. */
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
