// SPDX-License-Identifier: Apache-2.0

/** The organization settings a switch row writes. */
export type OrgToggleField =
  | "personal_model_credentials"
  | "dashboard_sso_enabled"
  | "restrict_package_copy"
  | "personal_space_role";

/** The two stored values of a setting that is not a boolean: what ON and OFF write. */
export interface ToggleValues {
  on: string;
  off: string;
}

/** `personal_space_role`: ON keeps a member `admin` of their personal space, OFF caps them. */
export const PERSONAL_SPACE_ROLE_VALUES = { on: "admin", off: "operator" } as const;

/** The PATCH body one flip of the switch sends: the boolean, or the stored value `values` names. */
export function toggleBody(field: OrgToggleField, checked: boolean, values?: ToggleValues) {
  return { [field]: values ? (checked ? values.on : values.off) : checked };
}
