// SPDX-License-Identifier: Apache-2.0

/**
 * The body of every schedule write. It carries the picks the user made, kept to the fired
 * version's integrations, and never the connection a fallback binds: the server names that one
 * (`withScheduleFallback`). A save that moves the actor or the version writes the connections of
 * the state it moves to.
 */

import { describe, it, expect } from "bun:test";
import {
  type ScheduleDraft,
  sameActor,
  savedScheduleOverrides,
  scheduleCreatePayload,
  scheduleExecutionPayload,
  scheduleUpdatePayload,
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

describe("scheduleUpdatePayload", () => {
  const stored = { actor: ALICE, versionOverride: null, picks: PICKS };
  const update = (
    draft: ScheduleDraft,
    over: Partial<Parameters<typeof scheduleUpdatePayload>[0]> = {},
  ) => scheduleUpdatePayload({ stored, draft, declared, ...over });

  it("sends nothing for an untouched draft", () => {
    expect(update({})).toEqual({});
  });

  it("sends the changed keys only, the name trimmed", () => {
    expect(update({ name: " Weekly ", cron: "0 8 * * 1", timezone: "Europe/Paris" })).toEqual({
      name: "Weekly",
      cron_expression: "0 8 * * 1",
      timezone: "Europe/Paris",
    });
    expect(update({ name: "   " })).toEqual({});
  });

  it("actor moved without picks: an explicit null, never an absent key", () => {
    const payload = update({ actor: BOB });
    expect(payload.actor).toEqual(BOB);
    expect("connection_overrides" in payload).toBe(true);
    expect(payload.connection_overrides).toBeNull();
  });

  it("an actor equal to the stored one moves nothing", () => {
    expect(update({ actor: ALICE })).toEqual({});
  });

  it("switching to the viewer sends no picks: the server names their fallback", () => {
    const payload = update({ actor: ALICE }, { stored: { ...stored, actor: BOB } });
    expect(payload).toEqual({ actor: ALICE, connection_overrides: null });
  });

  it("sends version_override only on a change, null when cleared", () => {
    expect("version_override" in update({ versionOverride: null })).toBe(false);
    expect(update({ versionOverride: "1.2.0" }).version_override).toBe("1.2.0");
    const frozen = { ...stored, versionOverride: "1.2.0" };
    expect(update({ versionOverride: null }, { stored: frozen }).version_override).toBeNull();
  });

  it("keeps the picks the NEW version declares", () => {
    const picks = { [GMAIL]: ["conn_1"], [SLACK]: ["conn_2"] };
    expect(
      update({ versionOverride: "2.0.0" }, { stored: { ...stored, picks }, declared: [SLACK] }),
    ).toEqual({ version_override: "2.0.0", connection_overrides: { [SLACK]: ["conn_2"] } });
  });

  it("with no declared integrations yet every pick is kept", () => {
    expect(update({ versionOverride: "2.0.0" }, { declared: undefined })).toEqual({
      version_override: "2.0.0",
      connection_overrides: PICKS,
    });
  });

  it("a pick replaces the whole map; none left is an explicit null", () => {
    expect(update({ picks: { [SLACK]: ["conn_2"] } }).connection_overrides).toEqual({
      [SLACK]: ["conn_2"],
    });
    expect(update({ picks: {} }).connection_overrides).toBeNull();
  });

  it("picks made for the new actor are the ones sent, the stored ones are dropped", () => {
    expect(update({ actor: BOB, picks: { [SLACK]: ["conn_9"] } })).toEqual({
      actor: BOB,
      connection_overrides: { [SLACK]: ["conn_9"] },
    });
  });

  it("an execution override clears with null, never an absent key", () => {
    expect(update({ overrides: { model_id_override: "m1" } })).toEqual({
      model_id_override: "m1",
      generation_config_override: null,
      proxy_id_override: null,
    });
  });

  it("sends the input body as given", () => {
    expect(update({ input: { topic: "ai" } })).toEqual({ input: { topic: "ai" } });
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
