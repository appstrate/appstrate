// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { ApiError } from "../../api/errors.ts";
import {
  integrationIdOfField,
  isChoiceRequest,
  refusalReasonKey,
  retryDecision,
  scheduleConnectionChoices,
  type ConnectionChoice,
  type ConnectionRefusal,
  type MissingIntegrationFieldError,
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
  scopes_granted: [],
  missing_scopes: [],
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
  const key = (code: ConnectionRefusal["code"]) =>
    refusalReasonKey({ integrationId: "@acme/gmail", code, candidates: [] });

  it("tells each refusal apart", () => {
    expect(key("override_connection_unavailable")).toBe("schedule.connectionOverrides.unavailable");
    expect(key("auth_serves_no_selected_tool")).toBe("error.authServesNoSelectedTool");
    expect(key("override_outranked")).toBe("error.overrideOutranked");
    expect(key("required_integration_unbound")).toBe("error.requiredIntegrationUnbound");
  });
});

describe("isChoiceRequest", () => {
  it("is a request for a choice, never a fault, only for a connection left to choose", () => {
    const choice = (code: ConnectionChoice["code"]): ConnectionChoice => ({
      integrationId: "@acme/gmail",
      code,
      candidates: [],
    });
    expect(isChoiceRequest(choice("must_choose_connection"))).toBe(true);
    expect(isChoiceRequest(choice("override_connection_unavailable"))).toBe(false);
    expect(isChoiceRequest(choice("required_integration_unbound"))).toBe(false);
  });
});

describe("retryDecision", () => {
  const fixable: MissingIntegrationFieldError[] = [
    { field: "integrations.@acme/slack", code: "not_connected", message: "connect" },
  ];
  const structural: MissingIntegrationFieldError = {
    field: "integrations.@acme/gmail",
    code: "integration_not_active",
    message: "inactive",
  };

  it("offers the re-run, enabled, once no refused row still blocks", () => {
    expect(retryDecision(fixable, false, [])).toEqual({ showRetry: true, canRetry: true });
    // A blocking integration the 409 did not name is not this modal's to answer.
    expect(retryDecision(fixable, false, ["@acme/drive"]).canRetry).toBe(true);
  });

  it("holds the re-run while the live readiness still blocks a refused row", () => {
    expect(retryDecision(fixable, false, ["@acme/slack"])).toEqual({
      showRetry: true,
      canRetry: false,
    });
  });

  it("does not gate on a verdict that has not loaded: the server stays the authority", () => {
    expect(retryDecision(fixable, false, undefined).canRetry).toBe(true);
  });

  it("holds the re-run while the launch is in flight", () => {
    expect(retryDecision(fixable, true, []).canRetry).toBe(false);
  });

  it("offers no re-run when every row is structural: nothing in the modal answers them", () => {
    expect(retryDecision([structural], false, []).showRetry).toBe(false);
  });

  it("holds the re-run beside a structural row still blocking, and frees it once it clears", () => {
    const mixed = [...fixable, structural];
    // The fixable row is answered; the structural one is not the modal's to fix.
    expect(retryDecision(mixed, false, ["@acme/gmail"])).toEqual({
      showRetry: true,
      canRetry: false,
    });
    expect(retryDecision(mixed, false, []).canRetry).toBe(true);
  });
});
