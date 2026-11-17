// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { memberLabel } from "../members.ts";

describe("memberLabel", () => {
  it("falls back to the address, then to the id, when there is no display name", () => {
    expect(memberLabel({ userId: "usr_x", email: "usr_x@acme.test" })).toBe("usr_x@acme.test");
    expect(memberLabel({ userId: "usr_x" })).toBe("usr_x");
  });
});
