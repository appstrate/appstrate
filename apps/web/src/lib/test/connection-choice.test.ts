// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { ApiError } from "../../api/errors.ts";
import {
  integrationIdOfField,
  isChoiceRequest,
  pendingConnectionChoices,
  picksAfterActorChange,
  refusalForActor,
  refusalReasonKey,
  retryDecision,
  scheduleConnectionChoices,
  withConnectionPickAs,
  type ConnectionChoice,
  type ConnectionRefusal,
  type MissingIntegrationFieldError,
} from "../connection-choice.ts";

function missingConnection(errors: unknown[] | undefined): ApiError {
  return new ApiError("missing_integration_connection", "refused", 409, errors);
}

const CANDIDATE = {
  id: "c1",
  label: "Work",
  account_id: "me@acme.test",
  owned_by_actor: true,
  needs_reconnection: false,
  scopes_granted: [],
  missing_scopes: [],
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
      {
        field: "integrations.@acme/crm",
        code: "required_integration_unbound",
        message: "required",
      },
      // The imposed set and the schedule's additions over the cap: fewer additions clear it.
      {
        field: "integrations.@acme/drive",
        code: "connection_set_too_large",
        message: "too many",
      },
    ]);
    expect(scheduleConnectionChoices(err)).toEqual([
      { integrationId: "@acme/gmail", code: "must_choose_connection", candidates: [CANDIDATE] },
      { integrationId: "@acme/notion", code: "override_connection_unavailable", candidates: [] },
      { integrationId: "@acme/ssh", code: "auth_serves_no_selected_tool", candidates: [] },
      { integrationId: "@acme/crm", code: "required_integration_unbound", candidates: [] },
      { integrationId: "@acme/drive", code: "connection_set_too_large", candidates: [] },
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

  it("brings it back when the sent set is picked again, in any order", () => {
    const sent = { "@acme/notion": ["a", "b"] };
    const pending = (current: Record<string, string[]>) =>
      pendingConnectionChoices(choices, sent, current).map((c) => c.integrationId);
    expect(pending({ "@acme/notion": ["a"] })).toEqual(["@acme/gmail"]);
    expect(pending({ "@acme/notion": ["b", "a"] })).toEqual(["@acme/gmail", "@acme/notion"]);
  });

  it("takes 'no connection' as an answer — `[]` is not the absent pick the save sent", () => {
    expect(ids({ "@acme/gmail": [], "@acme/notion": ["gone"] })).toEqual(["@acme/notion"]);
    expect(ids({ "@acme/gmail": ["c1"], "@acme/notion": [] })).toEqual([]);
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

describe("withConnectionPickAs", () => {
  const GMAIL = "@acme/gmail";
  // The viewer's picker opened a connect popup; this is the set it writes once it settles.
  const late = { pickedAs: ALICE, integrationId: GMAIL, connectionIds: ["c_alice", "c_new"] };

  it("lands on the overrides as they stand: a model changed while the popup was open is kept", () => {
    const now = { model_id_override: "m2", connection_overrides: { "@acme/slack": ["c_s"] } };
    expect(withConnectionPickAs(now, { ...late, runsAs: ALICE })).toEqual({
      model_id_override: "m2",
      connection_overrides: { "@acme/slack": ["c_s"], [GMAIL]: ["c_alice", "c_new"] },
    });
  });

  it("writes nothing once the schedule runs as someone else: the pick names the viewer's connections", () => {
    // The actor change dropped the picks; the late write must not put the viewer's back.
    const cleared = { model_id_override: "m2" };
    expect(withConnectionPickAs(cleared, { ...late, runsAs: BOB })).toBe(cleared);
    expect(withConnectionPickAs(cleared, { ...late, runsAs: undefined })).toBe(cleared);
  });

  it("clears a pick for the actor it was made for", () => {
    const now = { connection_overrides: { [GMAIL]: ["c_bob"] } };
    expect(
      withConnectionPickAs(now, {
        pickedAs: BOB,
        runsAs: BOB,
        integrationId: GMAIL,
        connectionIds: null,
      }),
    ).toEqual({});
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
  const key = (code: ConnectionRefusal["code"]) =>
    refusalReasonKey({ integrationId: "@acme/gmail", code, candidates: [] });

  it("tells each refusal apart", () => {
    expect(key("override_connection_unavailable")).toBe("schedule.connectionOverrides.unavailable");
    expect(key("auth_serves_no_selected_tool")).toBe("error.authServesNoSelectedTool");
    expect(key("override_outranked")).toBe("error.overrideOutranked");
    expect(key("connection_set_too_large")).toBe("error.connectionSetTooLarge");
    expect(key("required_integration_unbound")).toBe("error.requiredIntegrationUnbound");
  });
});

describe("isChoiceRequest", () => {
  it("is a request for a choice, never a fault, only for a connection left to choose", () => {
    const choice = (code: ConnectionChoice["code"]): ConnectionChoice => ({
      integrationId: "@acme/gmail",
      code,
      candidates: [],
    });
    expect(isChoiceRequest(choice("must_choose_connection"))).toBe(true);
    expect(isChoiceRequest(choice("override_connection_unavailable"))).toBe(false);
    expect(isChoiceRequest(choice("required_integration_unbound"))).toBe(false);
  });
});

describe("retryDecision", () => {
  const fixable: MissingIntegrationFieldError[] = [
    { field: "integrations.@acme/slack", code: "not_connected", message: "connect" },
  ];
  const structural: MissingIntegrationFieldError = {
    field: "integrations.@acme/gmail",
    code: "integration_not_active",
    message: "inactive",
  };

  it("offers the re-run, enabled, once no refused row still blocks", () => {
    expect(retryDecision(fixable, false, [])).toEqual({ showRetry: true, canRetry: true });
    // A blocking integration the 409 did not name is not this modal's to answer.
    expect(retryDecision(fixable, false, ["@acme/drive"]).canRetry).toBe(true);
  });

  it("holds the re-run while the live readiness still blocks a refused row", () => {
    expect(retryDecision(fixable, false, ["@acme/slack"])).toEqual({
      showRetry: true,
      canRetry: false,
    });
  });

  it("does not gate on a verdict that has not loaded: the server stays the authority", () => {
    expect(retryDecision(fixable, false, undefined).canRetry).toBe(true);
  });

  it("holds the re-run while the launch is in flight", () => {
    expect(retryDecision(fixable, true, []).canRetry).toBe(false);
  });

  it("offers no re-run when every row is structural: nothing in the modal answers them", () => {
    expect(retryDecision([structural], false, []).showRetry).toBe(false);
  });

  it("holds the re-run beside a structural row still blocking, and frees it once it clears", () => {
    const mixed = [...fixable, structural];
    // The fixable row is answered; the structural one is not the modal's to fix.
    expect(retryDecision(mixed, false, ["@acme/gmail"])).toEqual({
      showRetry: true,
      canRetry: false,
    });
    expect(retryDecision(mixed, false, []).canRetry).toBe(true);
  });
});
