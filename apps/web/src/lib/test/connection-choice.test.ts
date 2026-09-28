// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { ApiError } from "../../api/errors.ts";
import {
  integrationIdOfField,
  pendingConnectionChoices,
  scheduleConnectionChoices,
  type ConnectionChoice,
} from "../connection-choice.ts";

function missingConnection(errors: unknown): ApiError {
  return new ApiError(
    "missing_integration_connection",
    "refused",
    409,
    errors as Record<string, unknown>,
  );
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
    ]);
    expect(scheduleConnectionChoices(err)).toEqual([
      { integrationId: "@acme/gmail", code: "must_choose_connection", candidates: [CANDIDATE] },
      { integrationId: "@acme/notion", code: "override_connection_unavailable", candidates: [] },
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

describe("pendingConnectionChoices", () => {
  const choices: ConnectionChoice[] = [
    { integrationId: "@acme/gmail", code: "must_choose_connection", candidates: [CANDIDATE] },
    { integrationId: "@acme/notion", code: "override_connection_unavailable", candidates: [] },
  ];
  const submitted = { "@acme/notion": ["gone"] };
  const ids = (current: Record<string, string[]>) =>
    pendingConnectionChoices(choices, submitted, current).map((c) => c.integrationId);

  it("keeps every choice while the picks are the ones the refused save sent", () => {
    expect(ids({ "@acme/notion": ["gone"] })).toEqual(["@acme/gmail", "@acme/notion"]);
  });

  it("clears a choice as soon as its pick moves", () => {
    expect(ids({ "@acme/gmail": ["c1"], "@acme/notion": ["gone"] })).toEqual(["@acme/notion"]);
    expect(ids({})).toEqual(["@acme/gmail"]);
  });

  it("brings it back when the pick is undone", () => {
    expect(ids({ "@acme/gmail": [], "@acme/notion": ["gone"] })).toEqual([
      "@acme/gmail",
      "@acme/notion",
    ]);
  });
});
