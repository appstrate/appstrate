// SPDX-License-Identifier: Apache-2.0

/**
 * The invite form's cross-field rule between the org role and the per-space
 * assignments, and the list each role actually sends.
 *
 * There is only one rule left, and it is a transform rather than a verdict:
 * `admin` sends nothing. The "a guest must name a space" rule is gone on both
 * sides — every membership provisions the member's own personal space (RBAC
 * spec §3.6), so a guest invited for one shared package needs no team grant.
 */

import { describe, it, expect } from "bun:test";
import { assignmentsFor, toSpaceAssignments } from "../../lib/space-assignments.ts";

const ONE = [{ space_id: "spc_1", preset_role: "operator" as const }];

describe("assignmentsFor", () => {
  it("drops an admin's rows", () => {
    expect(assignmentsFor("admin", ONE)).toEqual([]);
  });

  it("keeps what every other role was given", () => {
    expect(assignmentsFor("guest", ONE)).toEqual(ONE);
    expect(assignmentsFor("member", ONE)).toEqual(ONE);
  });
});

describe("toSpaceAssignments", () => {
  it("maps a preset row to `preset_role` and a custom row to `custom_role_id`", () => {
    expect(
      toSpaceAssignments([
        { space_id: "spc_1", role: "preset:builder" },
        { space_id: "spc_2", role: "custom:srl_abc" },
      ]),
    ).toEqual([
      { space_id: "spc_1", preset_role: "builder" },
      { space_id: "spc_2", custom_role_id: "srl_abc" },
    ]);
  });

  it("drops rows that are not yet complete", () => {
    expect(toSpaceAssignments([{ space_id: "spc_1", role: "" }])).toEqual([]);
  });
});
