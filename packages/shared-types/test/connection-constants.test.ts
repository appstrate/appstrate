// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { CONNECTION_ACTIONS, CONNECTION_SCOPES } from "../src/index.ts";

describe("connection constants", () => {
  it("CONNECTION_SCOPES lists the two reach values", () => {
    expect(CONNECTION_SCOPES).toEqual(["org", "space"]);
  });

  it("CONNECTION_ACTIONS lists the actions a caller may take on a connection", () => {
    expect(CONNECTION_ACTIONS).toEqual(["rename", "share", "unshare_here"]);
  });
});
