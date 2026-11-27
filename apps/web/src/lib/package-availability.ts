// SPDX-License-Identifier: Apache-2.0

import type { PackageType } from "@appstrate/core/validation";
import type { PackageAvailability } from "@appstrate/shared-types";

type Availability = Pick<PackageAvailability, "via" | "state" | "shared_by">;

/**
 * The sentences, by state then grammatical gender: an integration is feminine in French
 * (« Activée · partagée »), an agent or a skill masculine. Named in full rather than through an
 * i18next context, so every key keeps a literal reference (`locales/test/locale-keys.test.ts`).
 */
const KEYS = {
  on: {
    masculine: {
      home: "packages.availability.home",
      system: "packages.availability.system",
      organization: "packages.availability.organization",
      shared: "packages.availability.shared",
      sharedBy: "packages.availability.sharedBy",
    },
    feminine: {
      home: "packages.availability.home_integration",
      system: "packages.availability.system_integration",
      organization: "packages.availability.organization_integration",
      shared: "packages.availability.shared_integration",
      sharedBy: "packages.availability.sharedBy_integration",
    },
  },
  off: {
    masculine: {
      home: "packages.availability.off.home",
      system: "packages.availability.off.system",
      organization: "packages.availability.off.organization",
      available: "packages.availability.available",
      shared: "packages.availability.off.shared",
      sharedBy: "packages.availability.off.sharedBy",
    },
    feminine: {
      home: "packages.availability.off.home_integration",
      system: "packages.availability.off.system_integration",
      organization: "packages.availability.off.organization_integration",
      available: "packages.availability.available_integration",
      shared: "packages.availability.off.shared_integration",
      sharedBy: "packages.availability.off.sharedBy_integration",
    },
  },
} as const;

/**
 * The `settings` sentence saying whether the space runs the package and how it got there (the
 * badge of its page and the « Dans cet espace » row of its availability card): « Activé · … » or
 * « Non activé · … » with the provenance, `none` (no row here) reading as not activated.
 */
export function availabilityLabel(
  { via, state, shared_by }: Availability,
  type: PackageType,
): {
  key: string;
  params: { name?: string };
} {
  // `none` is no row of its own here, yet the placement exists (home, system): it reads off,
  // and through the organization it is an offer waiting to be switched on.
  if (via === "organization" && state === "none") {
    return {
      key: KEYS.off[type === "integration" ? "feminine" : "masculine"].available,
      params: {},
    };
  }
  const keys =
    KEYS[state === "active" ? "on" : "off"][type === "integration" ? "feminine" : "masculine"];
  if (via !== "shared") return { key: keys[via], params: {} };
  return shared_by
    ? { key: keys.sharedBy, params: { name: shared_by.name } }
    : { key: keys.shared, params: {} };
}
