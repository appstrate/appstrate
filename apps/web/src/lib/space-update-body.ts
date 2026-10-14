// SPDX-License-Identifier: Apache-2.0

/**
 * The `PATCH /api/spaces/{id}` body for one setting of a space's General page.
 *
 * Each control commits on its own, so the body carries that control's field
 * and nothing else. Sending the others would not be neutral: the route refuses
 * `visibility` and `default_role` on a personal space whatever their value
 * (409 `personal_space_immutable`), so a rename that carried them would fail.
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

/** A domain list as stored: an empty row is the residue of editing, not a domain. */
function cleanDomains(domains: readonly string[]): string[] {
  return domains.map((domain) => domain.trim()).filter(Boolean);
}

/** Whether `next` would store anything other than `stored`: leaving an untouched field writes nothing. */
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
