// SPDX-License-Identifier: Apache-2.0

/**
 * The `PATCH /api/orgs/{orgId}` body for one setting. Each control commits alone
 * and the route merges (an absent field is left unchanged), so each body carries
 * its own field only — which is also what lets each row say « Enregistré » for
 * its own write (`fieldWriteState`).
 */

import type { AppearanceColor } from "@appstrate/core/appearance";
import type { paths } from "../api/client";

type OrgUpdateBody = NonNullable<
  paths["/api/orgs/{orgId}"]["patch"]["requestBody"]
>["content"]["application/json"];

export type OrgSettingChange =
  | { field: "name"; value: string }
  | { field: "icon"; value: string | null }
  | { field: "color"; value: AppearanceColor | null };

export function orgUpdateBody(change: OrgSettingChange): OrgUpdateBody {
  switch (change.field) {
    case "name":
      return { name: change.value };
    case "icon":
      return { icon: change.value };
    case "color":
      return { color: change.value };
  }
}
