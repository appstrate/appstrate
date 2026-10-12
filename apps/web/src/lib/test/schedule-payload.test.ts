// SPDX-License-Identifier: Apache-2.0

/**
 * The body of a schedule write, built from the form's state. The picks travel as the form holds
 * them, on an actor change too: dropped behind its back, the server would reset them and refuse
 * the save again. The connection the fallback binds is named for a schedule running as the
 * viewer, never for another actor, and only the fired version's integrations are kept.
 */

import { describe, it, expect } from "bun:test";
import { sameActor, savedScheduleOverrides, scheduleSavePayload } from "../schedule-payload.ts";
import type { FallbackBindingEntry } from "../connection-set.ts";

const ALICE = { userId: "usr_alice" };
const BOB = { userId: "usr_bob" };
const GMAIL = "@acme/gmail";
const SLACK = "@acme/slack";
const PICKS = { [GMAIL]: ["conn_1"] };
const FIELDS = { name: "Daily", cron_expression: "0 9 * * *", timezone: "UTC", enabled: true };

/** The viewer's own Gmail connection, bound by the fallback. */
const viewerReadiness: FallbackBindingEntry[] = [
  {
    integration_package_id: GMAIL,
    inert: false,
    resolution: { source: "fallback_auto", resolved_connection_ids: ["conn_own"] },
  },
];
const declared = [GMAIL, SLACK];

type SaveState = Omit<Parameters<typeof scheduleSavePayload>[0], "isEdit">;

/** A form state that decides nothing: every test names what it changes. */
const STATE: SaveState = {
  fields: FIELDS,
  input: {},
  overrides: {},
  runsAsViewer: false,
  viewerReadiness: undefined,
  declared: undefined,
  versionOverride: undefined,
  versionOverrideChanged: false,
  actor: undefined,
  currentActor: undefined,
};

/** An edit of Alice's schedule, the form seeded with her as the actor. */
function edit(state: Partial<SaveState>) {
  const seeded = { ...STATE, actor: ALICE, currentActor: ALICE };
  return scheduleSavePayload({ ...seeded, ...state, isEdit: true });
}

function create(state: Partial<SaveState>) {
  return scheduleSavePayload({ ...STATE, ...state, isEdit: false });
}

describe("scheduleSavePayload — edit", () => {
  it("sends the fields, and every override as a value or an explicit null", () => {
    expect(edit({ input: { topic: "ai" } })).toEqual({
      name: "Daily",
      cron_expression: "0 9 * * *",
      timezone: "UTC",
      enabled: true,
      input: { topic: "ai" },
      model_id_override: null,
      generation_config_override: null,
      proxy_id_override: null,
      connection_overrides: null,
    });
  });

  it("sends an empty input, which releases the values the schedule froze", () => {
    expect(edit({}).input).toEqual({});
  });

  it("actor unchanged: no actor key, the picks as they stand", () => {
    const payload = edit({ overrides: { connection_overrides: PICKS } });
    expect("actor" in payload).toBe(false);
    expect(payload.connection_overrides).toEqual(PICKS);
  });

  it("actor changed with picks: sends both, so the server keeps the new picks", () => {
    const payload = edit({ actor: BOB, overrides: { connection_overrides: PICKS } });
    expect(payload.actor).toEqual(BOB);
    expect(payload.connection_overrides).toEqual(PICKS);
  });

  it("actor changed without picks: an explicit null, never an absent key", () => {
    const payload = edit({ actor: BOB });
    expect(payload.actor).toEqual(BOB);
    expect("connection_overrides" in payload).toBe(true);
    expect(payload.connection_overrides).toBeNull();
  });

  it("sends version_override only on a change, null when cleared", () => {
    expect("version_override" in edit({})).toBe(false);
    expect(edit({ versionOverrideChanged: true }).version_override).toBeNull();
    const frozen = edit({ versionOverride: "1.2.0", versionOverrideChanged: true });
    expect(frozen.version_override).toBe("1.2.0");
  });
});

describe("scheduleSavePayload — create", () => {
  it("omits everything empty, including the actor (the caller by default) and `enabled`", () => {
    expect(create({ fields: { ...FIELDS, name: "" } })).toEqual({
      cron_expression: "0 9 * * *",
      timezone: "UTC",
      input: {},
    });
  });

  it("sends the picked actor, version and picks", () => {
    expect(
      create({
        overrides: { connection_overrides: PICKS, model_id_override: "m1" },
        versionOverride: "1.2.0",
        versionOverrideChanged: true,
        actor: BOB,
      }),
    ).toEqual({
      name: "Daily",
      cron_expression: "0 9 * * *",
      timezone: "UTC",
      input: {},
      model_id_override: "m1",
      connection_overrides: PICKS,
      version_override: "1.2.0",
      actor: BOB,
    });
  });
});

describe("scheduleSavePayload — the connections a save names", () => {
  const viewer = { runsAsViewer: true, viewerReadiness, declared };
  const other = { runsAsViewer: false, viewerReadiness, declared };

  it("names the connection the viewer's fallback binds, on a create and on an edit", () => {
    expect(create(viewer).connection_overrides).toEqual({ [GMAIL]: ["conn_own"] });
    expect(edit(viewer).connection_overrides).toEqual({ [GMAIL]: ["conn_own"] });
  });

  it("never names the viewer's connection on a schedule running as someone else", () => {
    expect("connection_overrides" in create(other)).toBe(false);
    expect(edit(other).connection_overrides).toBeNull();
    const picks = { [SLACK]: ["conn_2"] };
    const picked = edit({ ...other, overrides: { connection_overrides: picks } });
    expect(picked.connection_overrides).toEqual(picks);
  });

  it("keeps only the integrations the fired version declares", () => {
    const overrides = { connection_overrides: { [SLACK]: ["conn_2"], "@acme/gone": ["conn_3"] } };
    expect(edit({ ...viewer, overrides }).connection_overrides).toEqual({
      [SLACK]: ["conn_2"],
      [GMAIL]: ["conn_own"],
    });
    expect(edit({ ...viewer, declared: [] }).connection_overrides).toBeNull();
  });
});

describe("savedScheduleOverrides", () => {
  it("is what the save sends: the fallback's set beside the declared picks, the rest untouched", () => {
    const overrides = { connection_overrides: { [SLACK]: ["conn_2"] }, model_id_override: "m1" };
    expect(
      savedScheduleOverrides({ overrides, runsAsViewer: true, viewerReadiness, declared }),
    ).toEqual({
      connection_overrides: { [SLACK]: ["conn_2"], [GMAIL]: ["conn_own"] },
      model_id_override: "m1",
    });
    expect(
      savedScheduleOverrides({ overrides: {}, runsAsViewer: false, viewerReadiness, declared }),
    ).toEqual({});
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
