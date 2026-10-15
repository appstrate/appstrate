// SPDX-License-Identifier: Apache-2.0

/**
 * The body of every schedule write. It carries the picks the user made, kept to the fired
 * version's integrations, and never the connection a fallback binds: the server names that one
 * (`withScheduleFallback`). A move of the actor or the version writes the connections of the
 * state it moves to.
 */

import { describe, it, expect } from "bun:test";
import {
  dueScheduleMove,
  sameActor,
  savedScheduleOverrides,
  scheduleConnectionPickPayload,
  scheduleCreatePayload,
  scheduleExecutionPayload,
  scheduleMovePayload,
  scheduleRefusalAnswerPayload,
} from "../schedule-payload.ts";

const ALICE = { userId: "usr_alice" };
const BOB = { userId: "usr_bob" };
const GMAIL = "@acme/gmail";
const SLACK = "@acme/slack";
const PICKS = { [GMAIL]: ["conn_1"] };

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

  it("names no connection the user did not pick", () => {
    expect("connection_overrides" in create({ declared })).toBe(false);
  });
});

describe("scheduleMovePayload", () => {
  const stored = { actor: ALICE, versionOverride: null, picks: PICKS };
  const move = (args: Partial<Parameters<typeof scheduleMovePayload>[0]>) =>
    scheduleMovePayload({
      stored,
      next: {},
      declared,
      ...args,
    });

  it("actor changed without picks: an explicit null, never an absent key", () => {
    const payload = move({ next: { actor: BOB } });
    expect(payload.actor).toEqual(BOB);
    expect("connection_overrides" in payload).toBe(true);
    expect(payload.connection_overrides).toBeNull();
  });

  it("switching to the viewer sends no picks: the server names their fallback", () => {
    const payload = move({ stored: { ...stored, actor: BOB }, next: { actor: ALICE } });
    expect(payload).toEqual({ actor: ALICE, connection_overrides: null });
  });

  it("sends version_override only on a change, null when cleared", () => {
    expect("version_override" in move({ next: { versionOverride: null } })).toBe(false);
    expect(move({ next: { versionOverride: "1.2.0" } }).version_override).toBe("1.2.0");
    const frozen = { ...stored, versionOverride: "1.2.0" };
    expect(move({ stored: frozen, next: { versionOverride: null } }).version_override).toBeNull();
    expect("actor" in move({ next: { actor: ALICE } })).toBe(false);
  });

  it("keeps the picks the NEW version declares", () => {
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
  });
});

describe("dueScheduleMove", () => {
  const args = {
    stored: { actor: BOB, versionOverride: null, picks: PICKS },
    next: { versionOverride: "2.0.0" },
  };

  it("holds the move while the next version's declared integrations load", () => {
    expect(dueScheduleMove({ ...args, ready: false, declared: undefined })).toBeNull();
  });

  it("once they settle, sends it with the connections of the state it moves to", () => {
    expect(dueScheduleMove({ ...args, ready: true, declared })).toEqual({
      version_override: "2.0.0",
      connection_overrides: PICKS,
    });
  });
});

describe("scheduleExecutionPayload", () => {
  it("sends every override, null when cleared", () => {
    expect(scheduleExecutionPayload({})).toEqual({
      model_id_override: null,
      generation_config_override: null,
      proxy_id_override: null,
    });
    expect(
      scheduleExecutionPayload({ model_id_override: "gpt", proxy_id_override: "prx_1" }),
    ).toEqual({
      model_id_override: "gpt",
      generation_config_override: null,
      proxy_id_override: "prx_1",
    });
  });

  it("never carries the connection picks", () => {
    const payload = scheduleExecutionPayload({ connection_overrides: PICKS });
    expect("connection_overrides" in payload).toBe(false);
  });
});

describe("scheduleRefusalAnswerPayload", () => {
  const sent = { id: "sch_1", version_override: "2.0.0", connection_overrides: PICKS };

  it("re-sends the refused write whole, its picks replaced", () => {
    expect<unknown>(scheduleRefusalAnswerPayload(sent, { [SLACK]: ["conn_2"] })).toEqual({
      id: "sch_1",
      version_override: "2.0.0",
      connection_overrides: { [SLACK]: ["conn_2"] },
    });
  });

  it("clears the map when nothing is picked", () => {
    expect<unknown>(scheduleRefusalAnswerPayload({ id: "sch_1", actor: BOB }, {})).toEqual({
      id: "sch_1",
      actor: BOB,
      connection_overrides: null,
    });
  });
});

describe("scheduleConnectionPickPayload", () => {
  it("sends the stored picks with this one replaced, kept to the declared integrations", () => {
    expect(
      scheduleConnectionPickPayload({
        picks: { ...PICKS, "@acme/gone": ["conn_x"] },
        integrationId: SLACK,
        connectionIds: ["conn_slack"],
        declared,
      }),
    ).toEqual({ connection_overrides: { ...PICKS, [SLACK]: ["conn_slack"] } });
  });

  it("names no fallback for an integration the pick leaves unpicked", () => {
    expect(
      scheduleConnectionPickPayload({
        picks: null,
        integrationId: SLACK,
        connectionIds: ["conn_slack"],
        declared,
      }),
    ).toEqual({ connection_overrides: { [SLACK]: ["conn_slack"] } });
  });

  it("sends null once the last pick is removed", () => {
    expect(
      scheduleConnectionPickPayload({
        picks: PICKS,
        integrationId: GMAIL,
        connectionIds: null,
        declared,
      }),
    ).toEqual({ connection_overrides: null });
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
  it("keeps only the integrations the fired version declares", () => {
    const overrides = {
      connection_overrides: { [SLACK]: ["conn_2"], "@acme/gone": ["conn_3"] },
      model_id_override: "m1",
    };
    expect(savedScheduleOverrides({ overrides, declared })).toEqual({
      connection_overrides: { [SLACK]: ["conn_2"] },
      model_id_override: "m1",
    });
    expect(savedScheduleOverrides({ overrides, declared: [] })).toEqual({
      model_id_override: "m1",
    });
  });

  it("keeps every pick while the declared integrations load, and a pick to none", () => {
    const overrides = { connection_overrides: { [GMAIL]: [] } };
    expect(savedScheduleOverrides({ overrides, declared: undefined })).toEqual(overrides);
    expect(savedScheduleOverrides({ overrides, declared })).toEqual(overrides);
  });
});
