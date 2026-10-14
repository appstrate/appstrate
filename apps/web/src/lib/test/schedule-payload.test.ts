// SPDX-License-Identifier: Apache-2.0

/**
 * The body of every schedule write. The connection the fallback binds is named for a schedule
 * running as the viewer, never for another actor, and only the fired version's integrations are
 * kept. A move of the actor or the version writes the connections of the state it moves to.
 */

import { describe, it, expect } from "bun:test";
import {
  armedScheduleWrite,
  sameActor,
  savedScheduleOverrides,
  scheduleConnectionPickPayload,
  scheduleCreatePayload,
  scheduleMovePayload,
} from "../schedule-payload.ts";
import type { FallbackBindingEntry } from "../connection-set.ts";

const ALICE = { userId: "usr_alice" };
const BOB = { userId: "usr_bob" };
const GMAIL = "@acme/gmail";
const SLACK = "@acme/slack";
const PICKS = { [GMAIL]: ["conn_1"] };

/** The viewer's own Gmail connection, bound by the fallback. */
const viewerReadiness: FallbackBindingEntry[] = [
  {
    integration_package_id: GMAIL,
    inert: false,
    resolution: { source: "fallback_auto", resolved_connection_ids: ["conn_own"] },
  },
];
const declared = [GMAIL, SLACK];

type CreateState = Parameters<typeof scheduleCreatePayload>[0];

/** A create that decides nothing: every test names what it changes. */
function create(state: Partial<CreateState>) {
  return scheduleCreatePayload({
    name: "Daily",
    cron_expression: "0 9 * * *",
    timezone: "UTC",
    input: {},
    overrides: {},
    runsAsViewer: false,
    viewerReadiness: undefined,
    declared: undefined,
    versionOverride: undefined,
    actor: undefined,
    ...state,
  });
}

describe("scheduleCreatePayload", () => {
  it("omits everything empty, including the actor (the caller by default)", () => {
    expect(create({ name: "  " })).toEqual({
      cron_expression: "0 9 * * *",
      timezone: "UTC",
      input: {},
    });
  });

  it("sends the picked actor, version, model and picks", () => {
    expect(
      create({
        overrides: { connection_overrides: PICKS, model_id_override: "m1", proxy_id_override: "p" },
        versionOverride: "draft",
        actor: BOB,
        input: { topic: "ai" },
      }),
    ).toEqual({
      name: "Daily",
      cron_expression: "0 9 * * *",
      timezone: "UTC",
      input: { topic: "ai" },
      model_id_override: "m1",
      proxy_id_override: "p",
      connection_overrides: PICKS,
      version_override: "draft",
      actor: BOB,
    });
  });

  it("names the connection the viewer's fallback binds", () => {
    expect(create({ runsAsViewer: true, viewerReadiness, declared }).connection_overrides).toEqual({
      [GMAIL]: ["conn_own"],
    });
  });

  it("never names the viewer's connection on a schedule running as someone else", () => {
    const other = { runsAsViewer: false, viewerReadiness, declared, actor: BOB };
    expect("connection_overrides" in create(other)).toBe(false);
  });
});

describe("scheduleMovePayload", () => {
  const stored = { actor: ALICE, versionOverride: null, picks: PICKS };
  const move = (args: Partial<Parameters<typeof scheduleMovePayload>[0]>) =>
    scheduleMovePayload({
      stored,
      next: {},
      runsAsViewer: false,
      viewerReadiness: undefined,
      declared,
      ...args,
    });

  it("actor changed without picks: an explicit null, never an absent key", () => {
    const payload = move({ next: { actor: BOB } });
    expect(payload.actor).toEqual(BOB);
    expect("connection_overrides" in payload).toBe(true);
    expect(payload.connection_overrides).toBeNull();
  });

  it("drops the previous identity's picks, and never names the viewer's for another actor", () => {
    expect(move({ next: { actor: BOB }, viewerReadiness }).connection_overrides).toBeNull();
  });

  it("switching to the viewer names their fallback's set in the same write", () => {
    const payload = move({
      stored: { ...stored, actor: BOB },
      next: { actor: ALICE },
      runsAsViewer: true,
      viewerReadiness,
    });
    expect(payload).toEqual({ actor: ALICE, connection_overrides: { [GMAIL]: ["conn_own"] } });
  });

  it("sends version_override only on a change, null when cleared", () => {
    expect("version_override" in move({ next: { versionOverride: null } })).toBe(false);
    expect(move({ next: { versionOverride: "1.2.0" } }).version_override).toBe("1.2.0");
    const frozen = { ...stored, versionOverride: "1.2.0" };
    expect(move({ stored: frozen, next: { versionOverride: null } }).version_override).toBeNull();
    expect("actor" in move({ next: { actor: ALICE } })).toBe(false);
  });

  it("keeps the picks the NEW version declares, and names its fallback for the viewer", () => {
    const picks = { [GMAIL]: ["conn_1"], [SLACK]: ["conn_2"] };
    const payload = move({
      stored: { ...stored, picks },
      next: { versionOverride: "2.0.0" },
      declared: [SLACK],
    });
    expect(payload).toEqual({
      version_override: "2.0.0",
      connection_overrides: { [SLACK]: ["conn_2"] },
    });
    const viewer = move({
      stored: { ...stored, picks: null },
      next: { versionOverride: "2.0.0" },
      runsAsViewer: true,
      viewerReadiness,
    });
    expect(viewer.connection_overrides).toEqual({ [GMAIL]: ["conn_own"] });
  });
});

describe("scheduleConnectionPickPayload", () => {
  it("names the viewer's fallback for the integrations the pick leaves unpicked", () => {
    // Running as the viewer, Gmail required and bound only by the fallback: picking Slack
    // alone would be re-checked without Gmail and refused over it.
    expect(
      scheduleConnectionPickPayload({
        picks: null,
        integrationId: SLACK,
        connectionIds: ["conn_slack"],
        runsAsViewer: true,
        viewerReadiness,
        declared,
      }),
    ).toEqual({ connection_overrides: { [GMAIL]: ["conn_own"], [SLACK]: ["conn_slack"] } });
  });

  it("names nothing for another actor, and keeps only the declared integrations", () => {
    expect(
      scheduleConnectionPickPayload({
        picks: { ...PICKS, "@acme/gone": ["conn_x"] },
        integrationId: SLACK,
        connectionIds: ["conn_slack"],
        runsAsViewer: false,
        viewerReadiness,
        declared,
      }),
    ).toEqual({ connection_overrides: { ...PICKS, [SLACK]: ["conn_slack"] } });
  });

  it("sends null once the last pick is removed and nothing is named", () => {
    expect(
      scheduleConnectionPickPayload({
        picks: PICKS,
        integrationId: GMAIL,
        connectionIds: null,
        runsAsViewer: false,
        viewerReadiness,
        declared,
      }),
    ).toEqual({ connection_overrides: null });
  });
});

describe("armedScheduleWrite", () => {
  const named = { [GMAIL]: ["conn_own"] };
  const write = { cron_expression: "0 8 * * *" };

  it("re-sends the named set on a write to an armed schedule", () => {
    expect(armedScheduleWrite(write, { enabled: true, named })).toEqual({
      ...write,
      connection_overrides: named,
    });
  });

  it("re-sends it on the write that arms the schedule, not on the one that disarms it", () => {
    const enable = { enabled: true };
    expect(armedScheduleWrite(enable, { enabled: false, named })).toEqual({
      ...enable,
      connection_overrides: named,
    });
    const disable = { enabled: false };
    expect(armedScheduleWrite(disable, { enabled: true, named })).toBe(disable);
  });

  it("leaves the write alone when disarmed, nothing is named, or it decides the set itself", () => {
    expect(armedScheduleWrite(write, { enabled: false, named })).toBe(write);
    expect(armedScheduleWrite(write, { enabled: true, named: undefined })).toBe(write);
    const own = { connection_overrides: null };
    expect(armedScheduleWrite(own, { enabled: true, named })).toBe(own);
    const moved = { actor: BOB, connection_overrides: null };
    expect(armedScheduleWrite(moved, { enabled: true, named })).toBe(moved);
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

describe("savedScheduleOverrides", () => {
  const viewer = { runsAsViewer: true, viewerReadiness, declared };

  it("names the connection the viewer's fallback binds, beside the declared picks", () => {
    const overrides = { connection_overrides: { [SLACK]: ["conn_2"] }, model_id_override: "m1" };
    expect(savedScheduleOverrides({ overrides, ...viewer })).toEqual({
      connection_overrides: { [SLACK]: ["conn_2"], [GMAIL]: ["conn_own"] },
      model_id_override: "m1",
    });
  });

  it("never names the viewer's connection on a schedule running as someone else", () => {
    const other = { runsAsViewer: false, viewerReadiness, declared };
    expect(savedScheduleOverrides({ overrides: {}, ...other })).toEqual({});
    const picks = { connection_overrides: { [SLACK]: ["conn_2"] } };
    expect(savedScheduleOverrides({ overrides: picks, ...other })).toEqual(picks);
  });

  it("keeps only the integrations the fired version declares", () => {
    const overrides = { connection_overrides: { [SLACK]: ["conn_2"], "@acme/gone": ["conn_3"] } };
    expect(savedScheduleOverrides({ overrides, ...viewer }).connection_overrides).toEqual({
      [SLACK]: ["conn_2"],
      [GMAIL]: ["conn_own"],
    });
    expect(savedScheduleOverrides({ overrides, ...viewer, declared: [] })).toEqual({});
  });

  it("leaves a pick the user made, even to none, in place of the fallback", () => {
    const overrides = { connection_overrides: { [GMAIL]: [] } };
    expect(savedScheduleOverrides({ overrides, ...viewer }).connection_overrides).toEqual({
      [GMAIL]: [],
    });
  });
});
