// SPDX-License-Identifier: Apache-2.0

import type { TFunction } from "i18next";

/**
 * What to CALL a space in the UI.
 *
 * A personal space's stored `name` is a datum the server writes once
 * (`"Mon espace"`, `ensurePersonalSpace`); the label is the reader's own
 * translation, keyed off `personal` — the wire deliberately never says whose
 * space it is (RBAC spec §3.6). A team space is called what its members named
 * it.
 *
 * One helper because the rule was spelled out at three call sites (the org
 * switcher, the spaces list and the orphaned-spaces section) and a fourth would
 * have spelled it a fourth way. The namespace is pinned rather than inherited:
 * two of those callers have `settings` as a secondary namespace.
 */
export function spaceLabel(space: { personal: boolean; name: string }, t: TFunction): string {
  return space.personal ? t("spaces.personal.title", { ns: "settings" }) : space.name;
}
