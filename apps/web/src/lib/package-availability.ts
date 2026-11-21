// SPDX-License-Identifier: Apache-2.0

import type { PackageType } from "@appstrate/core/validation";
import type { PackageAvailability } from "@appstrate/shared-types";

type Availability = Pick<PackageAvailability, "via" | "state" | "shared_by">;

const ON = {
  home: "packages.availability.home",
  system: "packages.availability.system",
  organization: "packages.availability.organization",
  shared: "packages.availability.shared",
  sharedBy: "packages.availability.sharedBy",
} as const;
const OFF = {
  home: "packages.availability.off.home",
  system: "packages.availability.off.system",
  organization: "packages.availability.off.organization",
  shared: "packages.availability.off.shared",
  sharedBy: "packages.availability.off.sharedBy",
} as const;

/**
 * The `settings` sentence saying whether the space runs the package and how it got there (the
 * badge of its page and the « Dans cet espace » row of its availability card): « Activé · … » or
 * « Non activé · … » with the provenance, `none` (no row here) reading as not activated. An
 * integration is feminine in French: the `integration` i18next context picks its variant.
 */
export function availabilityLabel(
  { via, state, shared_by }: Availability,
  type: PackageType,
): {
  key: string;
  params: { name?: string; context?: "integration" };
} {
  // `none` is no row of its own here, yet the placement exists (home, system): it reads off.
  const keys = state === "active" ? ON : OFF;
  const context = type === "integration" ? { context: "integration" as const } : {};
  if (via !== "shared") return { key: keys[via], params: { ...context } };
  return shared_by
    ? { key: keys.sharedBy, params: { name: shared_by.name, ...context } }
    : { key: keys.shared, params: { ...context } };
}
