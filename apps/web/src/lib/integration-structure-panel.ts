// SPDX-License-Identifier: Apache-2.0

/**
 * What a panel of an integration's map (`?structurePanel=`) may show: the
 * package's own reads always; anything about connecting or governing waits for
 * the integration to be active in the space, and governing (auth, access) is
 * the administrator's.
 */
export function structurePanelState(
  section: string,
  active: boolean,
  canConfigure: boolean,
): "open" | "inactive" | "admin-only" {
  if (section === "files" || section === "tools" || section === "functioning") return "open";
  if (!active) return "inactive";
  return canConfigure || section.startsWith("connections:") ? "open" : "admin-only";
}
