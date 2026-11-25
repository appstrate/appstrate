// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { isRunDegraded, parseUnavailableTools } from "../run-degradation.ts";

describe("parseUnavailableTools", () => {
  it("reads the stamped entries", () => {
    expect(
      parseUnavailableTools({
        unavailable_tools: [{ integration_id: "@acme/gmail", name: "send", reason: "not_listed" }],
      }),
    ).toEqual([{ integrationId: "@acme/gmail", name: "send", reason: "not_listed" }]);
  });

  it("drops malformed entries and non-object metadata", () => {
    expect(parseUnavailableTools(null)).toEqual([]);
    expect(parseUnavailableTools({ unavailable_tools: "x" })).toEqual([]);
    expect(
      parseUnavailableTools({
        unavailable_tools: [null, { name: "a" }, { integration_id: "i", name: "b" }],
      }),
    ).toEqual([{ integrationId: "i", name: "b", reason: "" }]);
  });
});

describe("isRunDegraded", () => {
  it("is true for either warning and false otherwise", () => {
    expect(isRunDegraded({ degraded_integrations: ["@a/b"] })).toBe(true);
    expect(
      isRunDegraded({ unavailable_tools: [{ integration_id: "i", name: "n", reason: "r" }] }),
    ).toBe(true);
    expect(isRunDegraded({ degraded_integrations: [] })).toBe(false);
  });
});
