// SPDX-License-Identifier: Apache-2.0

/**
 * The billing-manager list the dashboard edits, as pure data.
 *
 * `PUT /api/billing/managers` replaces the whole set and refuses two things:
 * an id that is not a member of the organization, and an id whose org role
 * already carries `billing:manage` (owner, admin). Both refusals are about the
 * membership as it stands NOW, so they apply to the grants already stored just
 * as much as to the picker: a manager promoted to admin, or removed from the
 * org, turns the saved list into a body the server rejects wholesale. The
 * classification below is what keeps a save possible — those rows are shown,
 * explained, and left out of the body.
 */

import type { components } from "../api/client";

export type OrgMember = components["schemas"]["OrgMember"];

/**
 * The org roles the server refuses in `user_ids` — mirrors
 * `ROLES_WITH_BILLING_MANAGE` in `packages/module-ee/src/routes/billing.ts`.
 * They already hold `billing:read` + `billing:manage` through their role.
 */
const ROLES_WITH_BILLING_MANAGE: ReadonlySet<OrgMember["role"]> = new Set(["owner", "admin"]);

/** The members the picker may offer, in the order the org listing returns them. */
export function billingManagerCandidates(members: readonly OrgMember[]): OrgMember[] {
  return members.filter((member) => !ROLES_WITH_BILLING_MANAGE.has(member.role));
}

/** Display name for a member, falling back the way the members page does. */
export function memberLabel(member: OrgMember): string {
  return member.displayName || member.email || member.userId;
}

/**
 * Why a stored grant can no longer be sent back:
 * - `eligible` — the server accepts it;
 * - `role` — the user is now an owner or an admin;
 * - `gone` — the user is no longer a member of the organization.
 */
export type BillingManagerStatus = "eligible" | "role" | "gone";

/** One row of the "current managers" list: what is shown, and why. */
export interface BillingManagerRow {
  userId: string;
  label: string;
  /** Absent when the member carries no address, or is no longer in the org. */
  email: string | null;
  status: BillingManagerStatus;
}

/**
 * Join the grant rows (`user_id` only) with the org listing that carries names.
 *
 * A grant the server would now refuse is kept rather than dropped: hiding it
 * would leave the operator with a Save button that 400s on an id nothing on
 * screen names.
 */
export function billingManagerRows(
  userIds: readonly string[],
  members: readonly OrgMember[],
): BillingManagerRow[] {
  const byId = new Map(members.map((m) => [m.userId, m]));
  return userIds.map((userId) => {
    const member = byId.get(userId);
    return {
      userId,
      label: member ? memberLabel(member) : userId,
      email: member?.email && member.email !== memberLabel(member) ? member.email : null,
      status: !member ? "gone" : ROLES_WITH_BILLING_MANAGE.has(member.role) ? "role" : "eligible",
    };
  });
}

/** The ids a save may carry: the ones the server still accepts, de-duplicated. */
export function eligibleBillingManagers(
  userIds: readonly string[],
  members: readonly OrgMember[],
): string[] {
  return billingManagerRows([...new Set(userIds)], members)
    .filter((row) => row.status === "eligible")
    .map((row) => row.userId);
}

/** The `PUT` body: the complete set, minus every id the server would refuse. */
export function billingManagersBody(
  userIds: readonly string[],
  members: readonly OrgMember[],
): { user_ids: string[] } {
  return { user_ids: eligibleBillingManagers(userIds, members) };
}

/** Whether two manager lists name the same people, whatever their order. */
export function sameBillingManagers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  return b.every((id) => left.has(id));
}
