// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { ApiError } from "../../api/errors.ts";
import {
  integrationIdOfField,
  refusalReasonKey,
  scheduleConnectionChoices,
  type ConnectionChoice,
} from "../connection-choice.ts";

function missingConnection(errors: unknown[] | undefined): ApiError {
  return new ApiError("missing_integration_connection", "refused", 409, errors);
}

const CANDIDATE = {
  id: "c1",
  label: "Work",
  account_id: "me@acme.test",
  owned_by_actor: true,
  needs_reconnection: false,
};

describe("integrationIdOfField", () => {
  it("keeps the whole scoped package id", () => {
    expect(integrationIdOfField("integrations.@acme/gmail")).toBe("@acme/gmail");
  });
});

describe("scheduleConnectionChoices", () => {
  it("lists what only an edit of the schedule clears, with the actor's candidates", () => {
    const err = missingConnection([
      {
        field: "integrations.@acme/gmail",
        code: "must_choose_connection",
        message: "pick",
        candidate_connections: [CANDIDATE],
      },
      { field: "integrations.@acme/slack", code: "not_connected", message: "connect" },
      {
        field: "integrations.@acme/notion",
        code: "override_connection_unavailable",
        message: "gone",
      },
      {
        field: "integrations.@acme/ssh",
        code: "auth_serves_no_selected_tool",
        message: "unserving",
      },
      {
        field: "integrations.@acme/crm",
        code: "required_integration_unbound",
        message: "required",
      },
    ]);
    expect(scheduleConnectionChoices(err)).toEqual([
      { integrationId: "@acme/gmail", code: "must_choose_connection", candidates: [CANDIDATE] },
      { integrationId: "@acme/notion", code: "override_connection_unavailable", candidates: [] },
      { integrationId: "@acme/ssh", code: "auth_serves_no_selected_tool", candidates: [] },
      { integrationId: "@acme/crm", code: "required_integration_unbound", candidates: [] },
    ]);
  });

  it("is empty for any other error", () => {
    expect(scheduleConnectionChoices(new ApiError("locked_input_field", "locked", 400))).toEqual(
      [],
    );
    expect(scheduleConnectionChoices(new Error("network"))).toEqual([]);
    expect(scheduleConnectionChoices(null)).toEqual([]);
    expect(scheduleConnectionChoices(missingConnection(undefined))).toEqual([]);
  });
});

describe("refusalReasonKey", () => {
  const key = (code: ConnectionChoice["code"], candidates = [CANDIDATE]) =>
    refusalReasonKey({ integrationId: "@acme/gmail", code, candidates });

  it("tells each refusal apart", () => {
    expect(key("must_choose_connection")).toBe("schedule.connectionOverrides.mustChoose");
    expect(key("override_connection_unavailable")).toBe("schedule.connectionOverrides.unavailable");
    expect(key("auth_serves_no_selected_tool")).toBe("error.authServesNoSelectedTool");
    expect(key("override_outranked")).toBe("error.overrideOutranked");
    expect(key("required_integration_unbound")).toBe("error.requiredIntegrationUnbound");
  });

  it("an open choice with nothing the caller may name is the actor's (or an admin's) to make", () => {
    expect(key("must_choose_connection", [])).toBe("schedule.connectionOverrides.actorMustChoose");
  });
});
