// SPDX-License-Identifier: Apache-2.0

/**
 * Mirrors the server's schedule governance rule: a schedule running as another
 * member is written only by an org owner/admin.
 */

import { describe, it, expect } from "bun:test";
import { canWriteSchedule, mayGovernMemberSchedule } from "../schedule-governance.ts";

const ME = "usr_me";
const OTHER = "usr_other";

describe("canWriteSchedule", () => {
  it("lets anyone write a schedule running as an end user", () => {
    expect(canWriteSchedule({ userId: null }, { userId: ME, orgRole: "member" })).toBe(true);
    expect(canWriteSchedule({ userId: undefined }, { userId: ME, orgRole: "guest" })).toBe(true);
  });

  it("lets a member write a schedule running as themselves", () => {
    expect(canWriteSchedule({ userId: ME }, { userId: ME, orgRole: "member" })).toBe(true);
  });

  it.each(["member", "guest"] as const)(
    "refuses a %s a schedule running as another member",
    (orgRole) => {
      expect(canWriteSchedule({ userId: OTHER }, { userId: ME, orgRole })).toBe(false);
    },
  );

  it.each(["owner", "admin"] as const)(
    "lets an %s write a schedule running as another member",
    (orgRole) => {
      expect(canWriteSchedule({ userId: OTHER }, { userId: ME, orgRole })).toBe(true);
    },
  );

  it("refuses while the caller is not known yet", () => {
    expect(canWriteSchedule({ userId: OTHER }, { userId: undefined, orgRole: null })).toBe(false);
  });
});

describe("mayGovernMemberSchedule", () => {
  it("is the same rule applied to a candidate actor", () => {
    expect(mayGovernMemberSchedule(OTHER, { userId: ME, orgRole: "member" })).toBe(false);
    expect(mayGovernMemberSchedule(ME, { userId: ME, orgRole: "member" })).toBe(true);
    expect(mayGovernMemberSchedule(OTHER, { userId: ME, orgRole: "admin" })).toBe(true);
  });
});
