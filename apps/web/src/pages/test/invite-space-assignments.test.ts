// SPDX-License-Identifier: Apache-2.0

/**
 * The invite form's cross-field rule between the org role and the per-space
 * assignments.
 *
 * It exists as a pure function so it can be a react-hook-form `Controller`
 * rule. That shape is the fix for a real bug: the rule used to run inside the
 * submit handler and report through `setError("assignments", …)` on a name RHF
 * had never registered. Such an error is never cleared by validation, so
 * `handleSubmit` kept seeing a non-empty `errors` and dropped every later
 * submit — the form was dead until a page reload. As a `validate` rule RHF owns
 * the whole lifecycle; what is pinned here is the verdict itself.
 */

import { describe, it, expect } from "bun:test";
import {
  toSpaceAssignments,
  validateSpaceAssignments,
} from "../org-settings/invite-assignments.ts";

const MESSAGE = "pick at least one space";
const ONE = [{ space_id: "spc_1", role: "preset:operator" }];

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
    expect(validateSpaceAssignments("guest", [{ space_id: "spc_1", role: "" }], MESSAGE)).toBe(
      MESSAGE,
    );
  });

  it("accepts a member with no assignment — they fall back to the open spaces", () => {
    expect(validateSpaceAssignments("member", [], MESSAGE)).toBe(true);
  });

  it("accepts an admin either way — they run every space and the list is dropped on submit", () => {
    expect(validateSpaceAssignments("admin", [], MESSAGE)).toBe(true);
    expect(validateSpaceAssignments("admin", ONE, MESSAGE)).toBe(true);
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
