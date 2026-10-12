// SPDX-License-Identifier: Apache-2.0

/**
 * The override half of a schedule write. The actor-change case is the one that
 * looped: the picks must travel as the form holds them, never be dropped behind
 * its back, or the server resets them and refuses the save again.
 */

import { describe, it, expect } from "bun:test";
import { sameActor, scheduleOverridePayload } from "../schedule-payload.ts";
import type { FallbackBindingEntry } from "../connection-set.ts";

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
    readiness: undefined,
    declared: undefined,
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
      readiness: undefined,
      declared: undefined,
      versionOverride: undefined,
      versionOverrideChanged: true,
      actor: ALICE,
      currentActor: ALICE,
    });
    expect(moved.version_override).toBeNull();
  });
});

describe("scheduleOverridePayload — edit after the agent dropped an integration", () => {
  // The form holds the whole stored map; the picker shows only the fired version's integrations.
  const stored = { ...PICKS, "@acme/retired": ["conn_9"] };
  const save = (declared: string[]) =>
    scheduleOverridePayload({
      isEdit: true,
      overrides: { connection_overrides: stored },
      readiness: undefined,
      declared,
      versionOverride: undefined,
      versionOverrideChanged: false,
      actor: ALICE,
      currentActor: ALICE,
    });

  it("sends only the declared keys, so the stale one is cleared instead of refused", () => {
    expect(save(["@acme/gmail"]).connection_overrides).toEqual(PICKS);
  });

  it("clears the map when none of its keys is declared any more", () => {
    expect(save([]).connection_overrides).toBeNull();
  });
});

describe("scheduleOverridePayload — create", () => {
  it("omits everything empty, including the actor (the caller by default)", () => {
    expect(
      scheduleOverridePayload({
        isEdit: false,
        overrides: {},
        readiness: undefined,
        declared: undefined,
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
        readiness: undefined,
        declared: undefined,
        versionOverride: "1.2.0",
        versionOverrideChanged: true,
        actor: BOB,
        currentActor: undefined,
      }),
    ).toEqual({ connection_overrides: PICKS, version_override: "1.2.0", actor: BOB });
  });
});

describe("scheduleOverridePayload — the fallback's binding", () => {
  const GMAIL = "@acme/gmail";
  const NAMED = { [GMAIL]: ["conn_own"] };
  type Verdict = FallbackBindingEntry[] | undefined;
  type Source = FallbackBindingEntry["resolution"]["source"];
  const verdict = (source: Source): FallbackBindingEntry[] => [
    {
      integration_package_id: GMAIL,
      inert: false,
      resolution: { source, error_code: null, resolved_connection_ids: ["conn_own"] },
    },
  ];
  const rest = {
    declared: [GMAIL],
    versionOverride: undefined,
    versionOverrideChanged: false,
    actor: undefined,
  };
  const create = (readiness: Verdict) =>
    scheduleOverridePayload({
      isEdit: false,
      overrides: {},
      readiness,
      currentActor: undefined,
      ...rest,
    });
  const edit = (readiness: Verdict, stored?: Record<string, string[]>) =>
    scheduleOverridePayload({
      isEdit: true,
      overrides: stored ? { connection_overrides: stored } : {},
      readiness,
      currentActor: ALICE,
      ...rest,
    });

  it("create for oneself: names the connection the fallback binds", () => {
    expect(create(verdict("fallback_auto")).connection_overrides).toEqual(NAMED);
  });

  it("edit of a stored schedule naming none: names it", () => {
    expect(edit(verdict("fallback_auto")).connection_overrides).toEqual(NAMED);
  });

  it("a member pin names the set: no entry", () => {
    expect("connection_overrides" in create(verdict("member_pin"))).toBe(false);
    expect(edit(verdict("member_pin")).connection_overrides).toBeNull();
  });

  it("no verdict (the schedule runs as someone else): no entry", () => {
    expect("connection_overrides" in create(undefined)).toBe(false);
    expect(edit(undefined).connection_overrides).toBeNull();
  });

  it("an inert integration: no entry", () => {
    const inert = verdict("fallback_auto").map((entry) => ({ ...entry, inert: true }));
    expect("connection_overrides" in create(inert)).toBe(false);
    expect(edit(inert).connection_overrides).toBeNull();
  });

  it("a stored pick is sent as it stands", () => {
    const stored = { [GMAIL]: ["conn_other"] };
    expect(edit(verdict("fallback_auto"), stored).connection_overrides).toEqual(stored);
  });

  it("names nothing for an integration the fired version does not declare", () => {
    const payload = scheduleOverridePayload({
      isEdit: false,
      overrides: {},
      readiness: verdict("fallback_auto"),
      currentActor: undefined,
      ...rest,
      declared: [],
    });
    expect("connection_overrides" in payload).toBe(false);
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
