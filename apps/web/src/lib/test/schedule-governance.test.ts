// SPDX-License-Identifier: Apache-2.0

/**
 * Mirrors the server's schedule governance rule: a schedule running as another
 * identity, member or end user, is written only by an org owner/admin.
 */

import { describe, it, expect } from "bun:test";
import { mayGovernScheduleActor } from "../schedule-governance.ts";

const ME = "usr_me";
const OTHER = "usr_other";

describe("mayGovernScheduleActor", () => {
  it("lets anyone through when no actor is named", () => {
    expect(mayGovernScheduleActor(null, { userId: ME, orgRole: "member" })).toBe(true);
    expect(mayGovernScheduleActor(undefined, { userId: ME, orgRole: "guest" })).toBe(true);
  });

  it("refuses a member a schedule running as an end user, and lets an admin", () => {
    expect(mayGovernScheduleActor("eu_1", { userId: ME, orgRole: "member" })).toBe(false);
    expect(mayGovernScheduleActor("eu_1", { userId: ME, orgRole: "admin" })).toBe(true);
  });

  it("lets a member govern a schedule running as themselves", () => {
    expect(mayGovernScheduleActor(ME, { userId: ME, orgRole: "member" })).toBe(true);
  });

  it.each(["member", "guest"] as const)(
    "refuses a %s a schedule running as another member",
    (orgRole) => {
      expect(mayGovernScheduleActor(OTHER, { userId: ME, orgRole })).toBe(false);
    },
  );

  it.each(["owner", "admin"] as const)(
    "lets an %s govern a schedule running as another member",
    (orgRole) => {
      expect(mayGovernScheduleActor(OTHER, { userId: ME, orgRole })).toBe(true);
    },
  );

  it("refuses while the caller is not known yet", () => {
    expect(mayGovernScheduleActor(OTHER, { userId: undefined, orgRole: null })).toBe(false);
  });
});
