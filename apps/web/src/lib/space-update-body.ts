// SPDX-License-Identifier: Apache-2.0

/**
 * `PATCH /api/spaces/{id}` bodies. The space form sends its text fields, only the edited
 * ones; visibility, default role, icon and colour are single choices written on their own.
 * The route refuses all four on a personal space (409 `personal_space_immutable`), so a
 * rename never carries them.
 */

import type { AppearanceColor } from "@appstrate/core/appearance";
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
}

/** Compare with the edit baseline, never with a refetch that may contain another admin's changes. */
export function spaceSettingsUpdate(
  baseline: SpaceSettingsDraft,
  next: SpaceSettingsDraft,
): SpaceUpdateBody {
  return {
    ...(next.name !== baseline.name ? { name: next.name.trim() } : {}),
    ...(domainsChanged(baseline.domains, next.domains)
      ? { settings: { allowedRedirectDomains: cleanDomains(next.domains) } }
      : {}),
  };
}

export type SpaceAppearanceChange =
  { field: "icon"; value: string | null } | { field: "color"; value: AppearanceColor | null };

/** The icon or the colour alone; `null` clears it. */
export function spaceAppearanceBody(change: SpaceAppearanceChange): SpaceUpdateBody {
  return change.field === "icon" ? { icon: change.value } : { color: change.value };
}
