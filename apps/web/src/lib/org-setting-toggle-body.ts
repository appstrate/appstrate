// SPDX-License-Identifier: Apache-2.0

import type { operations } from "../api/schema";

type SettingsPatch = NonNullable<
  operations["updateOrgSettings"]["requestBody"]
>["content"]["application/json"];
type BooleanToggle = {
  [K in keyof SettingsPatch]-?: NonNullable<SettingsPatch[K]> extends boolean ? K : never;
}[keyof SettingsPatch];

export type OrgToggleField = BooleanToggle | Extract<"personal_space_role", keyof SettingsPatch>;

/** A personal space role switch stores a role. The other switches store booleans. */
export function toggleBody(field: OrgToggleField, checked: boolean): SettingsPatch {
  return field === "personal_space_role"
    ? { personal_space_role: checked ? "admin" : "operator" }
    : { [field]: checked };
}
