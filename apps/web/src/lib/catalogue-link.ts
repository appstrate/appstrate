// SPDX-License-Identifier: Apache-2.0

/**
 * Where "Parcourir le catalogue" goes, from wherever it is offered.
 *
 * From a page that belongs to a space — its agents, skills or integrations —
 * the catalogue opens NARROWED to that space: that is what the reader was
 * looking at, and "what else is in here" is the question they bring. From the
 * navigation's own entry it opens on the whole map, because nothing on the
 * way in named a space.
 *
 * The narrowing is a chip the catalogue shows and removes in one click, so a
 * link never traps the reader in a view they cannot widen.
 */

import type { PackageType } from "@appstrate/core/validation";

export function catalogueHref(type: PackageType, spaceId?: string | null): string {
  // MCP servers have no tab of their own: they are integrations run locally.
  const kind = type === "mcp-server" ? "integration" : type;
  const base = `/catalogue/placed/${kind}`;
  return spaceId ? `${base}?space=${encodeURIComponent(spaceId)}` : base;
}
