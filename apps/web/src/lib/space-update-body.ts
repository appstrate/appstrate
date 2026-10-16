// SPDX-License-Identifier: Apache-2.0

/**
 * The `PATCH /api/spaces/{id}` body contains only edited fields:
 * the route refuses `visibility`/`default_role` on a personal space whatever their
 * value (409 `personal_space_immutable`), so a rename carrying them would fail.
 */

import type { components, paths } from "../api/client";

type SpaceUpdateBody = NonNullable<
  paths["/api/spaces/{id}"]["patch"]["requestBody"]
>["content"]["application/json"];
type SpaceObject = components["schemas"]["SpaceObject"];

function cleanDomains(domains: readonly string[]): string[] {
  return domains.map((domain) => domain.trim()).filter(Boolean);
}

export function domainsChanged(stored: readonly string[], next: readonly string[]): boolean {
  const before = cleanDomains(stored);
  const after = cleanDomains(next);
  return before.length !== after.length || after.some((domain, i) => domain !== before[i]);
}

/**
 * Leaving `open` ends the implicit members' access and unshares the
 * connections they shared in the space, which reopening does not restore.
 */
export function visibilityChangeNeedsConfirmation(
  from: SpaceObject["visibility"],
  to: SpaceObject["visibility"],
): boolean {
  return from === "open" && to !== "open";
}

export interface SpaceSettingsDraft {
  name: string;
  domains: string[];
  visibility: SpaceObject["visibility"];
  defaultRole: SpaceObject["default_role"];
}

/**
 * Compare with the edit baseline, never with a refetch that may contain another admin's changes.
 * A personal space never offers visibility or default role, so neither appears in its diff.
 */
export function spaceSettingsUpdate(
  baseline: SpaceSettingsDraft,
  next: SpaceSettingsDraft,
): SpaceUpdateBody {
  return {
    ...(next.name !== baseline.name ? { name: next.name.trim() } : {}),
    ...(domainsChanged(baseline.domains, next.domains)
      ? { settings: { allowedRedirectDomains: cleanDomains(next.domains) } }
      : {}),
    ...(next.visibility !== baseline.visibility ? { visibility: next.visibility } : {}),
    ...(next.defaultRole !== baseline.defaultRole ? { default_role: next.defaultRole } : {}),
  };
}
