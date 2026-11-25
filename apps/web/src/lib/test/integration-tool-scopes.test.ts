// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { countToolsWithoutScopes } from "../integration-tool-scopes.ts";

describe("countToolsWithoutScopes", () => {
  it("counts the available tools with no required scope", () => {
    expect(
      countToolsWithoutScopes([
        { status: "available" },
        { status: "available", policy: { required_scopes: {} } },
        { status: "available", policy: { required_scopes: { oauth: [] } } },
        { status: "available", policy: { required_scopes: { oauth: ["mail.read"] } } },
      ]),
    ).toBe(3);
  });

  it("ignores tools an agent cannot call", () => {
    expect(
      countToolsWithoutScopes([
        { status: "pending" },
        { status: "missing" },
        { status: "blocked" },
      ]),
    ).toBe(0);
  });
});
