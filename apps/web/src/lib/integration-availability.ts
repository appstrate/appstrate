// SPDX-License-Identifier: Apache-2.0

import type { IntegrationDetailWire } from "../hooks/use-integrations";

type Availability = Pick<IntegrationDetailWire["availability"], "via" | "state" | "shared_by">;

const ON = {
  home: "integration.availability.home",
  system: "integration.availability.system",
  organization: "integration.availability.organization",
  shared: "integration.availability.shared",
  sharedBy: "integration.availability.sharedBy",
} as const;
const OFF = {
  home: "integration.availability.off.home",
  system: "integration.availability.off.system",
  organization: "integration.availability.off.organization",
  shared: "integration.availability.off.shared",
  sharedBy: "integration.availability.off.sharedBy",
} as const;

/**
 * The `settings` sentence saying whether the space runs the integration and how it got there
 * (the badge of the page and its « Dans cet espace » row): « Activée · … » or « Non activée · … »
 * with the provenance, `none` (no row here) reading as not activated.
 */
export function availabilityLabel({ via, state, shared_by }: Availability): {
  key: string;
  params: { name?: string };
} {
  // `none` is no row of its own here, yet the placement exists (home, system): it reads off.
  const keys = state === "active" ? ON : OFF;
  if (via !== "shared") return { key: keys[via], params: {} };
  return shared_by
    ? { key: keys.sharedBy, params: { name: shared_by.name } }
    : { key: keys.shared, params: {} };
}
