// SPDX-License-Identifier: Apache-2.0

/**
 * Which kinds of package this caller may activate in the current space.
 *
 * The navigation entry, the route and the panel's rail all ask this same
 * question, and an entry that opens a panel with an empty rail is worse than no
 * entry at all. The answer is `catalogueKinds`, which reads the same verdict as
 * every activation control (`maySetPackageActive`).
 */
import type { PackageType } from "@appstrate/core/validation";
import { catalogueKinds } from "../lib/package-permissions";
import { useCurrentSpaceGrant } from "./use-permissions";

export function useCatalogueKinds(): PackageType[] {
  return catalogueKinds(useCurrentSpaceGrant());
}
