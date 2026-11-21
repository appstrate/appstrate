// SPDX-License-Identifier: Apache-2.0

import type { IntegrationDetailWire } from "../hooks/use-integrations";

type Availability = Pick<IntegrationDetailWire["availability"], "via" | "state" | "shared_by">;

/**
 * The `settings` sentence saying whether the space runs the integration and how it got there
 * (the badge of the page and its « Dans cet espace » row): « Activée · … » with the provenance,
 * « Non activée » when the space does not run it.
 */
export function availabilityLabel({ via, state, shared_by }: Availability): {
  key: string;
  params: { name?: string };
} {
  if (state !== "active") return { key: "integrations.badge.inactive", params: {} };
  switch (via) {
    case "home":
      return { key: "integration.availability.home", params: {} };
    case "system":
      return { key: "integration.availability.system", params: {} };
    case "organization":
      return { key: "integration.availability.organization", params: {} };
    case "shared":
      return shared_by
        ? { key: "integration.availability.sharedBy", params: { name: shared_by.name } }
        : { key: "integration.availability.shared", params: {} };
  }
}
