// SPDX-License-Identifier: Apache-2.0

/**
 * Mirrors the server's schedule governance rule: a schedule running as another
 * member is written only by an org owner/admin.
 */

import { describe, it, expect } from "bun:test";
import { mayGovernMemberSchedule } from "../schedule-governance.ts";

const ME = "usr_me";
const OTHER = "usr_other";

describe("mayGovernMemberSchedule", () => {
  it("lets anyone govern a schedule running as an end user", () => {
    expect(mayGovernMemberSchedule(null, { userId: ME, orgRole: "member" })).toBe(true);
    expect(mayGovernMemberSchedule(undefined, { userId: ME, orgRole: "guest" })).toBe(true);
  });

  it("lets a member govern a schedule running as themselves", () => {
    expect(mayGovernMemberSchedule(ME, { userId: ME, orgRole: "member" })).toBe(true);
  });

  it.each(["member", "guest"] as const)(
    "refuses a %s a schedule running as another member",
    (orgRole) => {
      expect(mayGovernMemberSchedule(OTHER, { userId: ME, orgRole })).toBe(false);
    },
  );

  it.each(["owner", "admin"] as const)(
    "lets an %s govern a schedule running as another member",
    (orgRole) => {
      expect(mayGovernMemberSchedule(OTHER, { userId: ME, orgRole })).toBe(true);
    },
  );

  it("refuses while the caller is not known yet", () => {
    expect(mayGovernMemberSchedule(OTHER, { userId: undefined, orgRole: null })).toBe(false);
  });
});
