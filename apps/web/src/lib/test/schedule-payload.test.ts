// SPDX-License-Identifier: Apache-2.0

/**
 * Two identities compared by who they are, and the overrides a schedule write stores: the
 * connection the fallback binds is named for a schedule running as the viewer, never for another
 * actor, and only the fired version's integrations are kept.
 */

import { describe, it, expect } from "bun:test";
import { sameActor, savedScheduleOverrides } from "../schedule-payload.ts";
import type { FallbackBindingEntry } from "../connection-set.ts";

describe("sameActor", () => {
  it("compares the identity, not the object", () => {
    expect(sameActor({ userId: "u" }, { userId: "u" })).toBe(true);
    expect(sameActor({ userId: "u" }, { endUserId: "u" })).toBe(false);
    expect(sameActor(undefined, undefined)).toBe(true);
    expect(sameActor({ userId: "u" }, undefined)).toBe(false);
  });
});

describe("savedScheduleOverrides", () => {
  const GMAIL = "@acme/gmail";
  const SLACK = "@acme/slack";
  const declared = [GMAIL, SLACK];
  /** The viewer's own Gmail connection, bound by the fallback. */
  const viewerReadiness: FallbackBindingEntry[] = [
    {
      integration_package_id: GMAIL,
      inert: false,
      resolution: { source: "fallback_auto", resolved_connection_ids: ["conn_own"] },
    },
  ];
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
