// SPDX-License-Identifier: Apache-2.0

/**
 * Mirrors the server's schedule governance rule: a schedule running as another member is written
 * by an org owner/admin, one running as an end user by whoever holds `api-keys:create`.
 */

import { describe, it, expect } from "bun:test";
import { mayGovernScheduleActor } from "../schedule-governance.ts";

const ME = "usr_me";
const OTHER = "usr_other";
const caller = (orgRole: "owner" | "admin" | "member" | "guest", canCreateApiKeys = false) => ({
  userId: ME,
  orgRole,
  canCreateApiKeys,
});

describe("mayGovernScheduleActor", () => {
  it("lets anyone through when no actor is named", () => {
    expect(mayGovernScheduleActor({}, caller("guest"))).toBe(true);
    expect(mayGovernScheduleActor({ userId: null, endUserId: null }, caller("member"))).toBe(true);
  });

  it("lets a member govern a schedule running as themselves", () => {
    expect(mayGovernScheduleActor({ userId: ME }, caller("member"))).toBe(true);
  });

  it.each(["member", "guest"] as const)(
    "refuses a %s a schedule running as another member, whatever they hold",
    (orgRole) => {
      expect(mayGovernScheduleActor({ userId: OTHER }, caller(orgRole, true))).toBe(false);
    },
  );

  it.each(["owner", "admin"] as const)(
    "lets an %s govern a schedule running as another member",
    (orgRole) => {
      expect(mayGovernScheduleActor({ userId: OTHER }, caller(orgRole))).toBe(true);
    },
  );

  it("keys a schedule running as an end user on api-keys:create, not on the org role", () => {
    expect(mayGovernScheduleActor({ endUserId: "eu_1" }, caller("member"))).toBe(false);
    expect(mayGovernScheduleActor({ endUserId: "eu_1" }, caller("member", true))).toBe(true);
    expect(mayGovernScheduleActor({ endUserId: "eu_1" }, caller("admin"))).toBe(false);
  });

  it("refuses while the caller is not known yet", () => {
    expect(
      mayGovernScheduleActor(
        { userId: OTHER },
        { userId: undefined, orgRole: null, canCreateApiKeys: false },
      ),
    ).toBe(false);
  });
});
