// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { ApiError } from "../../api/errors.ts";
import {
  integrationIdOfField,
  pendingConnectionChoices,
  picksAfterActorChange,
  refusalForActor,
  refusalReasonKey,
  scheduleConnectionChoices,
  type ConnectionChoice,
} from "../connection-choice.ts";

function missingConnection(errors: unknown): ApiError {
  return new ApiError(
    "missing_integration_connection",
    "refused",
    409,
    errors as Record<string, unknown>,
  );
}

const CANDIDATE = {
  id: "c1",
  label: "Work",
  account_id: "me@acme.test",
  owned_by_actor: true,
  needs_reconnection: false,
};

describe("integrationIdOfField", () => {
  it("keeps the whole scoped package id", () => {
    expect(integrationIdOfField("integrations.@acme/gmail")).toBe("@acme/gmail");
  });
});

describe("scheduleConnectionChoices", () => {
  it("lists what only an edit of the schedule clears, with the actor's candidates", () => {
    const err = missingConnection([
      {
        field: "integrations.@acme/gmail",
        code: "must_choose_connection",
        message: "pick",
        candidate_connections: [CANDIDATE],
      },
      { field: "integrations.@acme/slack", code: "not_connected", message: "connect" },
      {
        field: "integrations.@acme/notion",
        code: "override_connection_unavailable",
        message: "gone",
      },
      {
        field: "integrations.@acme/ssh",
        code: "auth_serves_no_selected_tool",
        message: "unserving",
      },
    ]);
    expect(scheduleConnectionChoices(err)).toEqual([
      { integrationId: "@acme/gmail", code: "must_choose_connection", candidates: [CANDIDATE] },
      { integrationId: "@acme/notion", code: "override_connection_unavailable", candidates: [] },
      { integrationId: "@acme/ssh", code: "auth_serves_no_selected_tool", candidates: [] },
    ]);
  });

  it("is empty for any other error", () => {
    expect(scheduleConnectionChoices(new ApiError("locked_input_field", "locked", 400))).toEqual(
      [],
    );
    expect(scheduleConnectionChoices(new Error("network"))).toEqual([]);
    expect(scheduleConnectionChoices(null)).toEqual([]);
    expect(scheduleConnectionChoices(missingConnection(undefined))).toEqual([]);
  });
});

describe("pendingConnectionChoices", () => {
  const choices: ConnectionChoice[] = [
    { integrationId: "@acme/gmail", code: "must_choose_connection", candidates: [CANDIDATE] },
    { integrationId: "@acme/notion", code: "override_connection_unavailable", candidates: [] },
  ];
  const submitted = { "@acme/notion": ["gone"] };
  const ids = (current: Record<string, string[]>) =>
    pendingConnectionChoices(choices, submitted, current).map((c) => c.integrationId);

  it("keeps every choice while the picks are the ones the refused save sent", () => {
    expect(ids({ "@acme/notion": ["gone"] })).toEqual(["@acme/gmail", "@acme/notion"]);
  });

  it("clears a choice as soon as its pick moves", () => {
    expect(ids({ "@acme/gmail": ["c1"], "@acme/notion": ["gone"] })).toEqual(["@acme/notion"]);
    expect(ids({})).toEqual(["@acme/gmail"]);
  });

  it("brings it back when the pick is undone", () => {
    expect(ids({ "@acme/gmail": [], "@acme/notion": ["gone"] })).toEqual([
      "@acme/gmail",
      "@acme/notion",
    ]);
  });
});

const ALICE = { userId: "usr_alice" };
const BOB = { userId: "usr_bob" };
const ALICE_PICKS = { "@acme/gmail": ["c_alice"] };
const BOB_PICKS = { "@acme/gmail": ["c_bob"] };

describe("picksAfterActorChange", () => {
  const stored = { actor: ALICE, picks: ALICE_PICKS };

  it("keeps the picks while the identity does not change", () => {
    expect(
      picksAfterActorChange({ picks: BOB_PICKS, runsAs: ALICE, nextRunsAs: ALICE, stored }),
    ).toBe(BOB_PICKS);
  });

  it("drops them on a real change: they named the previous identity's connections", () => {
    expect(
      picksAfterActorChange({ picks: ALICE_PICKS, runsAs: ALICE, nextRunsAs: BOB, stored }),
    ).toBeUndefined();
    expect(
      picksAfterActorChange({ picks: ALICE_PICKS, runsAs: ALICE, nextRunsAs: BOB, stored: null }),
    ).toBeUndefined();
  });

  it("restores the stored picks back on the schedule's own actor", () => {
    expect(
      picksAfterActorChange({ picks: undefined, runsAs: BOB, nextRunsAs: ALICE, stored }),
    ).toBe(ALICE_PICKS);
  });

  it("restores nothing on create, where no picks are stored", () => {
    expect(
      picksAfterActorChange({ picks: BOB_PICKS, runsAs: BOB, nextRunsAs: ALICE, stored: null }),
    ).toBeUndefined();
  });
});

describe("refusalForActor", () => {
  const choices: ConnectionChoice[] = [
    { integrationId: "@acme/gmail", code: "must_choose_connection", candidates: [CANDIDATE] },
  ];

  it("speaks for the identity the refused save was sent for", () => {
    expect(refusalForActor(choices, { runsAs: ALICE, picks: {} }, ALICE)).toBe(choices);
  });

  it("goes stale once the actor moves, and comes back with it", () => {
    const submitted = { runsAs: ALICE, picks: {} };
    expect(refusalForActor(choices, submitted, BOB)).toEqual([]);
    expect(refusalForActor(choices, submitted, ALICE)).toBe(choices);
  });

  it("is empty before any save and without a refusal", () => {
    expect(refusalForActor(choices, null, ALICE)).toEqual([]);
    expect(refusalForActor(undefined, { runsAs: ALICE, picks: {} }, ALICE)).toEqual([]);
  });
});

describe("refusalReasonKey", () => {
  const key = (code: ConnectionChoice["code"], candidates = [CANDIDATE]) =>
    refusalReasonKey({ integrationId: "@acme/gmail", code, candidates });

  it("tells each refusal apart", () => {
    expect(key("must_choose_connection")).toBe("schedule.connectionOverrides.mustChoose");
    expect(key("override_connection_unavailable")).toBe("schedule.connectionOverrides.unavailable");
    expect(key("auth_serves_no_selected_tool")).toBe("schedule.connectionOverrides.unserving");
    expect(key("override_outranked")).toBe("schedule.connectionOverrides.outranked");
  });

  it("an open choice with nothing the caller may name is the actor's (or an admin's) to make", () => {
    expect(key("must_choose_connection", [])).toBe("schedule.connectionOverrides.actorMustChoose");
  });
});
