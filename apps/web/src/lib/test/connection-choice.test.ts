// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { ApiError } from "../../api/errors.ts";
import { integrationIdOfField, mustChooseIntegrationIds } from "../connection-choice.ts";

function missingConnection(errors: unknown): ApiError {
  return new ApiError(
    "missing_integration_connection",
    "refused",
    409,
    errors as Record<string, unknown>,
  );
}

describe("integrationIdOfField", () => {
  it("keeps the whole scoped package id", () => {
    expect(integrationIdOfField("integrations.@acme/gmail")).toBe("@acme/gmail");
  });
});

describe("mustChooseIntegrationIds", () => {
  it("lists the integrations a 409 asks a connection choice for, and only those", () => {
    const err = missingConnection([
      { field: "integrations.@acme/gmail", code: "must_choose_connection", message: "pick" },
      { field: "integrations.@acme/slack", code: "not_connected", message: "connect" },
      { field: "integrations.@acme/notion", code: "must_choose_connection", message: "pick" },
    ]);
    expect(mustChooseIntegrationIds(err)).toEqual(["@acme/gmail", "@acme/notion"]);
  });

  it("is empty for any other error", () => {
    expect(mustChooseIntegrationIds(new ApiError("locked_input_field", "locked", 400))).toEqual([]);
    expect(mustChooseIntegrationIds(new Error("network"))).toEqual([]);
    expect(mustChooseIntegrationIds(null)).toEqual([]);
    expect(mustChooseIntegrationIds(missingConnection(undefined))).toEqual([]);
  });
});
