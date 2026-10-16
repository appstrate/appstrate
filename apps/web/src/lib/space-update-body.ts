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

export type SpaceSettingChange =
  | { field: "name"; value: string }
  | { field: "domains"; value: string[] }
  | { field: "visibility"; value: SpaceObject["visibility"] }
  | { field: "defaultRole"; value: SpaceObject["default_role"] };

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

export function spaceUpdateBody(change: SpaceSettingChange): SpaceUpdateBody {
  switch (change.field) {
    case "name":
      return { name: change.value.trim() };
    case "domains":
      return { settings: { allowedRedirectDomains: cleanDomains(change.value) } };
    case "visibility":
      return { visibility: change.value };
    case "defaultRole":
      return { default_role: change.value };
  }
}

export interface SpaceSettingsDraft {
  name: string;
  domains: string[];
  visibility: SpaceObject["visibility"];
  defaultRole: SpaceObject["default_role"];
}

/** Compare with the edit baseline, never with a refetch that may contain another admin's changes. */
export function spaceSettingsUpdate(
  baseline: SpaceSettingsDraft,
  next: SpaceSettingsDraft,
  personal: boolean,
): SpaceUpdateBody {
  return {
    ...(next.name !== baseline.name ? spaceUpdateBody({ field: "name", value: next.name }) : {}),
    ...(domainsChanged(baseline.domains, next.domains)
      ? spaceUpdateBody({ field: "domains", value: next.domains })
      : {}),
    ...(!personal && next.visibility !== baseline.visibility
      ? spaceUpdateBody({ field: "visibility", value: next.visibility })
      : {}),
    ...(!personal && next.defaultRole !== baseline.defaultRole
      ? spaceUpdateBody({ field: "defaultRole", value: next.defaultRole })
      : {}),
  };
}
