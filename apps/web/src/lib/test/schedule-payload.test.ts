// SPDX-License-Identifier: Apache-2.0

/** The override half of a schedule create. */

import { describe, it, expect } from "bun:test";
import { sameActor, scheduleOverridePayload } from "../schedule-payload.ts";

const BOB = { userId: "usr_bob" };
const PICKS = { "@acme/gmail": ["conn_1"] };

describe("scheduleOverridePayload — create", () => {
  it("omits everything empty, including the actor (the caller by default)", () => {
    expect(
      scheduleOverridePayload({
        overrides: {},
        versionOverride: undefined,
        actor: undefined,
      }),
    ).toEqual({});
  });

  it("sends the picked actor and picks", () => {
    expect(
      scheduleOverridePayload({
        overrides: { connection_overrides: PICKS },
        versionOverride: "1.2.0",
        actor: BOB,
      }),
    ).toEqual({ connection_overrides: PICKS, version_override: "1.2.0", actor: BOB });
  });
});

describe("sameActor", () => {
  it("compares the identity, not the object", () => {
    expect(sameActor({ userId: "u" }, { userId: "u" })).toBe(true);
    expect(sameActor({ userId: "u" }, { endUserId: "u" })).toBe(false);
    expect(sameActor(undefined, undefined)).toBe(true);
    expect(sameActor({ userId: "u" }, undefined)).toBe(false);
  });
});
