// SPDX-License-Identifier: Apache-2.0

/**
 * What the billing-manager picker may offer, and what a save sends.
 *
 * `PUT /api/billing/managers` refuses an owner or an admin with a 400 — they
 * already hold `billing:manage` through their org role — so the candidate list
 * is not a cosmetic filter: an owner in the picker is a refusal waiting to be
 * clicked.
 */

import { describe, expect, it } from "bun:test";
import {
  billingManagerCandidates,
  billingManagerRows,
  billingManagersBody,
  eligibleBillingManagers,
  memberLabel,
  sameBillingManagers,
  type OrgMember,
} from "../billing-managers.ts";

function member(overrides: Partial<OrgMember> & { userId: string }): OrgMember {
  return {
    displayName: overrides.userId,
    email: `${overrides.userId}@acme.test`,
    role: "member",
    joinedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const MEMBERS: OrgMember[] = [
  member({ userId: "usr_owner", displayName: "Olivia", role: "owner" }),
  member({ userId: "usr_admin", displayName: "Adam", role: "admin" }),
  member({ userId: "usr_member", displayName: "Manon", role: "member" }),
  member({ userId: "usr_guest", displayName: "Gaspard", role: "guest" }),
];

describe("billing manager candidates", () => {
  it("keeps out the roles the server refuses, and only those", () => {
    expect(billingManagerCandidates(MEMBERS).map((m) => m.userId)).toEqual([
      "usr_member",
      "usr_guest",
    ]);
  });

  it("offers nothing when every member already manages billing by role", () => {
    expect(billingManagerCandidates(MEMBERS.slice(0, 2))).toEqual([]);
  });
});

describe("billing manager rows", () => {
  it("names each grant from the org listing, with the address underneath", () => {
    expect(billingManagerRows(["usr_member"], MEMBERS)).toEqual([
      { userId: "usr_member", label: "Manon", email: "usr_member@acme.test", status: "eligible" },
    ]);
  });

  it("keeps a grant whose user left the org, and says which", () => {
    // Dropping it would leave a Save that 400s on an id nothing on screen names.
    expect(billingManagerRows(["usr_gone"], MEMBERS)).toEqual([
      { userId: "usr_gone", label: "usr_gone", email: null, status: "gone" },
    ]);
  });

  it("keeps a grant whose user became an owner or an admin, and says which", () => {
    expect(billingManagerRows(["usr_admin"], MEMBERS).map((r) => r.status)).toEqual(["role"]);
    expect(billingManagerRows(["usr_owner"], MEMBERS).map((r) => r.status)).toEqual(["role"]);
  });

  it("falls back to the address, then to the id, when there is no display name", () => {
    expect(memberLabel(member({ userId: "usr_x", displayName: undefined }))).toBe(
      "usr_x@acme.test",
    );
    expect(memberLabel({ userId: "usr_x", role: "member", joinedAt: "" })).toBe("usr_x");
  });
});

describe("the eligible set", () => {
  it("keeps the members the server still accepts, in order", () => {
    expect(eligibleBillingManagers(["usr_guest", "usr_member"], MEMBERS)).toEqual([
      "usr_guest",
      "usr_member",
    ]);
  });

  it("drops the ids the server would refuse the whole list over", () => {
    expect(eligibleBillingManagers(["usr_member", "usr_admin", "usr_gone"], MEMBERS)).toEqual([
      "usr_member",
    ]);
  });
});

describe("the PUT body", () => {
  it("carries the complete list, de-duplicated", () => {
    expect(billingManagersBody(["usr_member", "usr_guest", "usr_member"], MEMBERS)).toEqual({
      user_ids: ["usr_member", "usr_guest"],
    });
  });

  it("leaves out a stale grant instead of letting it refuse the save", () => {
    expect(billingManagersBody(["usr_member", "usr_admin", "usr_gone"], MEMBERS)).toEqual({
      user_ids: ["usr_member"],
    });
  });

  it("clears the set with an empty array rather than omitting the field", () => {
    expect(billingManagersBody([], MEMBERS)).toEqual({ user_ids: [] });
  });
});

describe("dirty detection", () => {
  it("ignores order and reports a real membership change", () => {
    expect(sameBillingManagers(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameBillingManagers(["a"], ["a", "b"])).toBe(false);
    expect(sameBillingManagers(["a"], ["b"])).toBe(false);
  });
});
