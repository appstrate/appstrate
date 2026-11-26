// SPDX-License-Identifier: Apache-2.0

import type { TFunction } from "i18next";

/** The sentence of a 409 `role_in_use`: one clause per kind of holder the refusal counts. */
export function roleInUseMessage(
  details: Record<string, unknown> | undefined,
  t: TFunction,
): string {
  const count = (key: string) => Number(details?.[key] ?? 0);
  const members = count("member_count");
  const invitations = count("pending_invitation_count");
  const signupPolicies = count("signup_assignment_count");
  return (
    [
      details?.org_default === true ? t("roles.inUseOrgDefault") : null,
      members > 0 ? t("roles.inUse", { count: members }) : null,
      invitations > 0 ? t("roles.inUseInvitations", { count: invitations }) : null,
      signupPolicies > 0 ? t("roles.inUseSignupPolicies", { count: signupPolicies }) : null,
    ]
      .filter(Boolean)
      .join(" ") || t("roles.inUse", { count: 0 })
  );
}
