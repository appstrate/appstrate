// SPDX-License-Identifier: Apache-2.0

import type { operations } from "../api/schema";

type SettingsPatch = NonNullable<
  operations["updateOrgSettings"]["requestBody"]
>["content"]["application/json"];

export type OrgToggleField = {
  [K in keyof SettingsPatch]-?: NonNullable<SettingsPatch[K]> extends boolean ? K : never;
}[keyof SettingsPatch];

export function toggleBody(field: OrgToggleField, checked: boolean): SettingsPatch {
  return { [field]: checked };
}
