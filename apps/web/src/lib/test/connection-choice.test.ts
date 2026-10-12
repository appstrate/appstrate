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
  withDefaultConnections,
  type ConnectionChoice,
} from "../connection-choice.ts";
import { withDeclaredConnections } from "../connection-set.ts";
import { scheduleOverridePayload } from "../schedule-payload.ts";

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
    ]);
    expect(scheduleConnectionChoices(err)).toEqual([
      { integrationId: "@acme/gmail", code: "must_choose_connection", candidates: [CANDIDATE] },
      { integrationId: "@acme/notion", code: "override_connection_unavailable", candidates: [] },
      { integrationId: "@acme/ssh", code: "auth_serves_no_selected_tool", candidates: [] },
      { integrationId: "@acme/crm", code: "required_integration_unbound", candidates: [] },
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
    // Undoing a pick removes the key: back to what the refused save sent.
    expect(ids({ "@acme/notion": ["gone"] })).toEqual(["@acme/gmail", "@acme/notion"]);
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

describe("withDefaultConnections", () => {
  type Entry = NonNullable<Parameters<typeof withDefaultConnections>[1]["readiness"]>[number];
  const entry = (id: string, resolution: Partial<Entry["resolution"]>): Entry => ({
    integration_package_id: id,
    resolution: {
      source: "fallback_auto",
      error_code: null,
      resolved_connection_ids: ["c_own"],
      ...resolution,
    },
  });
  const GMAIL = "@acme/gmail";
  const BOUND = [entry(GMAIL, {})];
  const picksOf = (
    picks: Record<string, string[]> | undefined,
    args: Partial<Parameters<typeof withDefaultConnections>[1]> = {},
  ) =>
    withDefaultConnections(picks ? { connection_overrides: picks } : {}, {
      actorIsViewer: true,
      readiness: BOUND,
      ...args,
    }).connection_overrides;

  it("names what readiness binds by default for a schedule running as the viewer", () => {
    expect(picksOf(undefined)).toEqual({ [GMAIL]: ["c_own"] });
  });

  it("names nothing a layer already names, nor an integration nothing binds", () => {
    const readiness = [
      entry(GMAIL, { source: "member_pin" }),
      entry("@acme/slack", { source: "org_default" }),
      entry("@acme/notion", { source: "org_default_enforced" }),
      entry("@acme/ssh", { source: "admin_pin" }),
      entry("@acme/crm", {
        source: null,
        error_code: "must_choose_connection",
        resolved_connection_ids: [],
      }),
    ];
    expect(picksOf(undefined, { readiness })).toBeUndefined();
  });

  it("leaves a default binding that fails its health check to the save's refusal", () => {
    const readiness = [entry(GMAIL, { error_code: "insufficient_scopes" })];
    expect(picksOf(undefined, { readiness })).toBeUndefined();
  });

  it("speaks for the viewer only, and waits for the verdict", () => {
    expect(picksOf(undefined, { actorIsViewer: false })).toBeUndefined();
    expect(picksOf(undefined, { readiness: undefined })).toBeUndefined();
  });

  it("gives way to a pick the form holds, 'no connection' included", () => {
    expect(picksOf({ [GMAIL]: ["c_other"] })).toEqual({ [GMAIL]: ["c_other"] });
    expect(picksOf({ [GMAIL]: [] })).toEqual({ [GMAIL]: [] });
    const slack = { "@acme/slack": ["c_slack"] };
    expect(picksOf(slack)).toEqual({ ...slack, [GMAIL]: ["c_own"] });
  });

  it("keeps the other overrides, and the value itself when it adds nothing", () => {
    const overrides = { model_id_override: "m1" };
    const args = { actorIsViewer: true, readiness: BOUND };
    expect(withDefaultConnections(overrides, args)).toEqual({
      model_id_override: "m1",
      connection_overrides: { [GMAIL]: ["c_own"] },
    });
    expect(withDefaultConnections(overrides, { ...args, actorIsViewer: false })).toBe(overrides);
  });

  it("drops with the actor: the default stood for the viewer's own connection", () => {
    const shown = picksOf(undefined);
    const kept = picksAfterActorChange({
      picks: shown,
      runsAs: ALICE,
      nextRunsAs: BOB,
      stored: null,
    });
    expect(kept).toBeUndefined();
    expect(picksOf(kept, { actorIsViewer: false })).toBeUndefined();
  });

  describe("what the schedule form saves", () => {
    // The form's own chain: defaults, then the declared narrowing, then the write's override half.
    const saved = (args: {
      isEdit: boolean;
      actorIsViewer: boolean;
      readiness: Entry[];
      stored?: Record<string, string[]>;
    }) => {
      const overrides = withDeclaredConnections(
        withDefaultConnections(args.stored ? { connection_overrides: args.stored } : {}, args),
        [GMAIL],
      );
      const rest = {
        overrides,
        versionOverride: undefined,
        versionOverrideChanged: false,
        actor: undefined,
        currentActor: args.isEdit ? ALICE : undefined,
      };
      return args.isEdit
        ? scheduleOverridePayload({ isEdit: true, ...rest })
        : scheduleOverridePayload({ isEdit: false, ...rest });
    };

    it("create as the viewer: names the connection bound by default", () => {
      const payload = saved({ isEdit: false, actorIsViewer: true, readiness: BOUND });
      expect(payload.connection_overrides).toEqual({ [GMAIL]: ["c_own"] });
    });

    it("edit of a stored schedule naming none: the same, so it converges on save", () => {
      const payload = saved({ isEdit: true, actorIsViewer: true, readiness: BOUND });
      expect(payload.connection_overrides).toEqual({ [GMAIL]: ["c_own"] });
    });

    it("a member pin names the set: no entry", () => {
      const readiness = [entry(GMAIL, { source: "member_pin" })];
      const created = saved({ isEdit: false, actorIsViewer: true, readiness });
      expect("connection_overrides" in created).toBe(false);
      const edited = saved({ isEdit: true, actorIsViewer: true, readiness });
      expect(edited.connection_overrides).toBeNull();
    });

    it("a schedule running as another member: no entry, whatever the viewer's verdict", () => {
      const created = saved({ isEdit: false, actorIsViewer: false, readiness: BOUND });
      expect("connection_overrides" in created).toBe(false);
      const edited = saved({ isEdit: true, actorIsViewer: false, readiness: BOUND });
      expect(edited.connection_overrides).toBeNull();
    });

    it("a stored pick is sent as it stands", () => {
      const stored = { [GMAIL]: ["c_other"] };
      const payload = saved({ isEdit: true, actorIsViewer: true, readiness: BOUND, stored });
      expect(payload.connection_overrides).toEqual(stored);
    });
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
    expect(key("auth_serves_no_selected_tool")).toBe("error.authServesNoSelectedTool");
    expect(key("override_outranked")).toBe("error.overrideOutranked");
    expect(key("required_integration_unbound")).toBe("error.requiredIntegrationUnbound");
  });

  it("an open choice with nothing the caller may name is the actor's (or an admin's) to make", () => {
    expect(key("must_choose_connection", [])).toBe("schedule.connectionOverrides.actorMustChoose");
  });
});
