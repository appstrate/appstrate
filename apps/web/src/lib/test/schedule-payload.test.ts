// SPDX-License-Identifier: Apache-2.0

/**
 * The override half of a schedule write. The actor-change case is the one that
 * looped: the picks must travel as the form holds them, never be dropped behind
 * its back, or the server resets them and refuses the save again.
 */

import { describe, it, expect } from "bun:test";
import { sameActor, scheduleOverridePayload } from "../schedule-payload.ts";

const ALICE = { userId: "usr_alice" };
const BOB = { userId: "usr_bob" };
const PICKS = { "@acme/gmail": ["conn_1"] };

function edit(args: {
  actor: { userId?: string; endUserId?: string } | undefined;
  picks?: Record<string, string[]>;
}) {
  return scheduleOverridePayload({
    isEdit: true,
    overrides: args.picks ? { connection_overrides: args.picks } : {},
    versionOverride: undefined,
    versionOverrideChanged: false,
    actor: args.actor,
    currentActor: ALICE,
  });
}

describe("scheduleOverridePayload — edit", () => {
  it("actor unchanged: no actor key, the picks as they stand", () => {
    const payload = edit({ actor: ALICE, picks: PICKS });
    expect("actor" in payload).toBe(false);
    expect(payload.connection_overrides).toEqual(PICKS);
  });

  it("actor changed with picks: sends both, so the server keeps the new picks", () => {
    const payload = edit({ actor: BOB, picks: PICKS });
    expect(payload.actor).toEqual(BOB);
    expect(payload.connection_overrides).toEqual(PICKS);
  });

  it("actor changed without picks: an explicit null, never an absent key", () => {
    const payload = edit({ actor: BOB });
    expect(payload.actor).toEqual(BOB);
    expect("connection_overrides" in payload).toBe(true);
    expect(payload.connection_overrides).toBeNull();
  });

  it("clears every override with null and sends version_override only on a change", () => {
    const payload = edit({ actor: ALICE });
    expect(payload).toEqual({
      model_id_override: null,
      generation_config_override: null,
      proxy_id_override: null,
      connection_overrides: null,
    });
    const moved = scheduleOverridePayload({
      isEdit: true,
      overrides: {},
      versionOverride: undefined,
      versionOverrideChanged: true,
      actor: ALICE,
      currentActor: ALICE,
    });
    expect(moved.version_override).toBeNull();
  });
});

describe("scheduleOverridePayload — create", () => {
  it("omits everything empty, including the actor (the caller by default)", () => {
    expect(
      scheduleOverridePayload({
        isEdit: false,
        overrides: {},
        versionOverride: undefined,
        versionOverrideChanged: false,
        actor: undefined,
        currentActor: undefined,
      }),
    ).toEqual({});
  });

  it("sends the picked actor and picks", () => {
    expect(
      scheduleOverridePayload({
        isEdit: false,
        overrides: { connection_overrides: PICKS },
        versionOverride: "1.2.0",
        versionOverrideChanged: true,
        actor: BOB,
        currentActor: undefined,
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
