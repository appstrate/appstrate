// SPDX-License-Identifier: Apache-2.0

// `PUT /api/billing/managers` replaces the whole set and refuses non-members and roles that already
// carry `billing:manage`. Both depend on membership NOW, so stored grants can go stale (promoted
// or removed manager): those rows are shown, explained, and left out of the body.

import { ORG_ROLES_WITH_FULL_ACCESS } from "@appstrate/core/permissions";

import { memberLabel, type OrgMember } from "./members";

/** Roles the server refuses in `user_ids`; read from core, like the route. */
const ROLES_WITH_BILLING_MANAGE: ReadonlySet<OrgMember["role"]> = new Set(
  ORG_ROLES_WITH_FULL_ACCESS,
);

export function billingManagerCandidates(members: readonly OrgMember[]): OrgMember[] {
  return members.filter((member) => !ROLES_WITH_BILLING_MANAGE.has(member.role));
}

/** `role`: now an owner or admin. `gone`: no longer a member. */
export type BillingManagerStatus = "eligible" | "role" | "gone";

export interface BillingManagerRow {
  userId: string;
  label: string;
  email: string | null;
  status: BillingManagerStatus;
}

/** A grant the server would now refuse is kept, not dropped: hiding it leaves a Save that 400s on an unnamed id. */
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

export function eligibleBillingManagers(
  userIds: readonly string[],
  members: readonly OrgMember[],
): string[] {
  return billingManagerRows([...new Set(userIds)], members)
    .filter((row) => row.status === "eligible")
    .map((row) => row.userId);
}

export function billingManagersBody(
  userIds: readonly string[],
  members: readonly OrgMember[],
): { user_ids: string[] } {
  return { user_ids: eligibleBillingManagers(userIds, members) };
}

export function sameBillingManagers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  return b.every((id) => left.has(id));
}
