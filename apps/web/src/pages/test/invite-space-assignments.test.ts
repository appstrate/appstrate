// SPDX-License-Identifier: Apache-2.0

/**
 * The invite form's cross-field rules between the org role and the per-space
 * assignments.
 *
 * They are pure functions so the validity half can be a react-hook-form
 * `Controller` `validate` rule, letting RHF own the error lifecycle; an error
 * set on an unregistered field name is never cleared. What is pinned here is
 * the verdict itself, and the list each role actually sends.
 */

import { describe, it, expect } from "bun:test";
import {
  assignmentsFor,
  toSpaceAssignments,
  validateSpaceAssignments,
} from "../../lib/space-assignments.ts";

const MESSAGE = "pick at least one space";
const ONE = [{ space_id: "spc_1", preset_role: "operator" as const }];

describe("validateSpaceAssignments", () => {
  it("refuses a guest with no assignment", () => {
    expect(validateSpaceAssignments("guest", [], MESSAGE)).toBe(MESSAGE);
  });

  it("accepts a guest once one space is assigned", () => {
    expect(validateSpaceAssignments("guest", ONE, MESSAGE)).toBe(true);
  });

  it("refuses a guest whose only row is still half-filled", () => {
    // A row is added space-first; until it carries a role it produces no wire
    // assignment, so it must not satisfy the rule either.
    expect(
      validateSpaceAssignments(
        "guest",
        toSpaceAssignments([{ space_id: "spc_1", role: "" }]),
        MESSAGE,
      ),
    ).toBe(MESSAGE);
  });

  it("accepts a member with no assignment — they fall back to the open spaces", () => {
    expect(validateSpaceAssignments("member", [], MESSAGE)).toBe(true);
  });

  it("accepts an admin either way — they run every space and the list is dropped", () => {
    expect(validateSpaceAssignments("admin", [], MESSAGE)).toBe(true);
    expect(validateSpaceAssignments("admin", ONE, MESSAGE)).toBe(true);
  });
});

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
