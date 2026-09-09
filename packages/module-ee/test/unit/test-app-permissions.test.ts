// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * The route harness authenticates by org role, so what it grants each role
 * decides which route tests can reach a route at all. The matrix below is
 * written out, not rebuilt from `permissionsContribution()` with the same
 * expression `permissionsForRole` uses — an expected value derived from the
 * code under test agrees with any grant, including a wrong one.
 *
 * Change a grant in `src/index.ts` and this fails: read the new matrix off the
 * contribution, decide whether it is the intent, then write it here.
 */

import { describe, expect, it } from "bun:test";
import { ORG_ROLES, type OrgRole } from "@appstrate/core/permissions";
import { permissionsForRole } from "../helpers/app.ts";

const EXPECTED: Record<OrgRole, string[]> = {
  owner: ["billing:manage", "billing:read"],
  admin: ["billing:manage", "billing:read"],
  member: ["billing:read"],
  // A guest is invited into one space and has no business reading what the
  // organization spends.
  guest: [],
};

describe("test app permissions", () => {
  it("grants each org role exactly the billing permissions the module declares", () => {
    const actual = Object.fromEntries(
      ORG_ROLES.map((role) => [role, [...permissionsForRole(role)].sort()]),
    );

    expect(actual).toEqual(EXPECTED);
  });
});
