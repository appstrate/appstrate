// SPDX-License-Identifier: Apache-2.0

/** Two identities compared by who they are. */

import { describe, it, expect } from "bun:test";
import { sameActor } from "../schedule-payload.ts";

describe("sameActor", () => {
  it("compares the identity, not the object", () => {
    expect(sameActor({ userId: "u" }, { userId: "u" })).toBe(true);
    expect(sameActor({ userId: "u" }, { endUserId: "u" })).toBe(false);
    expect(sameActor(undefined, undefined)).toBe(true);
    expect(sameActor({ userId: "u" }, undefined)).toBe(false);
  });
});
