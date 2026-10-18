// SPDX-License-Identifier: Apache-2.0

/**
 * The admin pin PUT replaces the whole pin, its mode included: an absent
 * `allow_additional_connections` reads « exact ». Every body the SPA sends therefore names the flag
 * (pinned through `pinDraftVerdict`), and every write rewrites the stored set, so a set naming a
 * connection no longer shared (or the pin of an agent inactive in the space) cannot be saved at all.
 */

import { describe, expect, it } from "bun:test";
import { additionsRefusal, initialPinDraft, pinDraftVerdict, pinMode } from "../admin-pin-payload";

const WEB = "11111111-1111-4111-8111-111111111111";
const DB = "22222222-2222-4222-8222-222222222222";

describe("pinMode", () => {
  it("reads « exact » off a closed pin, the default, and « plus » off an open one", () => {
    expect(pinMode({ allow_additional_connections: false })).toBe("exact");
    expect(pinMode({ allow_additional_connections: true })).toBe("plus");
  });
});

describe("additionsRefusal", () => {
  const closed = (connection_ids: string[] | null) => ({ connection_ids });
  const space = { enforcedDefault: false, unavailableIds: [], agentInactive: false };

  it("refuses « plus » over no imposed connection, chosen or not", () => {
    expect(additionsRefusal(closed([]), space)).toBe("no_imposed_connection");
    expect(additionsRefusal(closed(null), space)).toBe("no_imposed_connection");
  });

  it("refuses « plus » while the space enforces a default", () => {
    expect(additionsRefusal(closed([WEB]), { ...space, enforcedDefault: true })).toBe(
      "enforced_default",
    );
    expect(additionsRefusal(closed([WEB]), space)).toBeNull();
  });

  it("refuses while the set names an unavailable connection", () => {
    // The write rewrites the stored set, which the server refuses (404) over that member.
    const gone = { ...space, unavailableIds: [DB] };
    expect(additionsRefusal(closed([WEB, DB]), gone)).toBe("unavailable_connection");
    expect(additionsRefusal(closed([WEB]), gone)).toBeNull();
  });

  it("refuses first while the pin's agent is not active in the space", () => {
    // The write rewrites the pin, which the server refuses (404) for an agent not active there.
    const inactive = { ...space, agentInactive: true };
    expect(additionsRefusal(closed([WEB]), inactive)).toBe("inactive_agent");
    expect(additionsRefusal(closed([]), inactive)).toBe("inactive_agent");
    expect(
      additionsRefusal(closed([WEB, DB]), {
        enforcedDefault: true,
        unavailableIds: [DB],
        agentInactive: true,
      }),
    ).toBe("inactive_agent");
  });
});

describe("initialPinDraft", () => {
  it("starts a new pin with no agent, no connection and « exact »", () => {
    expect(initialPinDraft(null)).toEqual({ agent: "", connectionIds: [], chosenMode: "exact" });
  });

  it("starts an edited pin on its own agent, set (unavailable members included) and mode", () => {
    expect(
      initialPinDraft({
        agent_package_id: "@acme/ops",
        connection_ids: [DB, WEB],
        allow_additional_connections: true,
      }),
    ).toEqual({ agent: "@acme/ops", connectionIds: [DB, WEB], chosenMode: "plus" });
  });
});

describe("pinDraftVerdict", () => {
  const space = { enforcedDefault: false, unavailableIds: [], agentInactive: false };
  const stored = (connection_ids: string[], allow_additional_connections: boolean) => ({
    connection_ids,
    allow_additional_connections,
  });

  it("sends a new pin's set and mode, the flag always named", () => {
    expect(
      pinDraftVerdict({ ...space, stored: null, connectionIds: [WEB, DB], chosenMode: "plus" }),
    ).toEqual({
      mode: "plus",
      refusal: null,
      savable: true,
      consequence: null,
      body: { connection_ids: [WEB, DB], allow_additional_connections: true },
    });
    expect(
      pinDraftVerdict({ ...space, stored: null, connectionIds: [], chosenMode: "exact" }),
    ).toMatchObject({
      savable: true,
      consequence: "clears_choices",
      body: { connection_ids: [], allow_additional_connections: false },
    });
  });

  it("reads « exact » when « plus » is refused, whatever was chosen", () => {
    expect(
      pinDraftVerdict({ ...space, stored: null, connectionIds: [], chosenMode: "plus" }),
    ).toMatchObject({
      mode: "exact",
      refusal: "no_imposed_connection",
      body: { allow_additional_connections: false },
    });
    expect(
      pinDraftVerdict({
        ...space,
        enforcedDefault: true,
        stored: null,
        connectionIds: [WEB],
        chosenMode: "plus",
      }),
    ).toMatchObject({ mode: "exact", refusal: "enforced_default", savable: true });
  });

  it("has nothing to save while the edited pin is unchanged, its set's order aside", () => {
    expect(
      pinDraftVerdict({
        ...space,
        stored: stored([WEB, DB], false),
        connectionIds: [DB, WEB],
        chosenMode: "exact",
      }),
    ).toMatchObject({ savable: false, consequence: null });
  });

  describe("the consequence announced, by the move saving makes", () => {
    const consequence = (
      from: boolean | null,
      ids: string[],
      to: "exact" | "plus",
      over: Partial<Parameters<typeof pinDraftVerdict>[0]> = {},
    ) =>
      pinDraftVerdict({
        ...space,
        stored: from === null ? null : stored([WEB], from),
        connectionIds: ids,
        chosenMode: to,
        ...over,
      }).consequence;

    it("clears the members' choices for a NEW pin saved in « exact » only", () => {
      expect(consequence(null, [WEB], "exact")).toBe("clears_choices");
      expect(consequence(null, [], "exact")).toBe("clears_choices");
      expect(consequence(null, [WEB], "plus")).toBeNull();
    });

    it("clears them, and disables schedules, going from « plus » to « exact » only", () => {
      expect(consequence(true, [WEB], "exact")).toBe("clears_choices_and_schedules");
      expect(consequence(true, [DB], "exact")).toBe("clears_choices_and_schedules");
      // Even when « plus » was refused and reads « exact » (an enforced default, a set emptied).
      expect(consequence(true, [WEB], "plus", { enforcedDefault: true })).toBe(
        "clears_choices_and_schedules",
      );
      expect(consequence(true, [], "plus")).toBe("clears_choices_and_schedules");
    });

    it("announces nothing for an « exact » pin edited, « exact » to « plus », or « plus » kept", () => {
      // A closed pin has no member choice to clear: the server deleted them when it was closed.
      expect(consequence(false, [DB], "exact")).toBeNull();
      expect(consequence(false, [WEB, DB], "exact")).toBeNull();
      expect(consequence(false, [WEB], "plus")).toBeNull();
      expect(consequence(false, [WEB, DB], "plus")).toBeNull();
      expect(consequence(true, [WEB, DB], "plus")).toBeNull();
    });

    it("announces nothing while the draft is blocked, the mode chosen kept for display", () => {
      const inactive = { agentInactive: true };
      expect(consequence(true, [WEB], "exact", inactive)).toBeNull();
      expect(consequence(null, [WEB], "exact", inactive)).toBeNull();
      const gone = { unavailableIds: [DB] };
      expect(consequence(true, [WEB, DB], "exact", gone)).toBeNull();
      expect(consequence(null, [WEB, DB], "exact", gone)).toBeNull();
    });
  });

  it("keeps the mode chosen when the draft is blocked, and forces « exact » for another refusal", () => {
    const draft = (over: Partial<Parameters<typeof pinDraftVerdict>[0]>) =>
      pinDraftVerdict({
        ...space,
        stored: stored([WEB], true),
        connectionIds: [WEB, DB],
        chosenMode: "plus",
        ...over,
      });
    // Blocked: nothing can be saved, so the select keeps showing what the admin chose.
    expect(draft({ agentInactive: true })).toMatchObject({
      mode: "plus",
      refusal: "inactive_agent",
      savable: false,
      consequence: null,
    });
    expect(draft({ unavailableIds: [DB] })).toMatchObject({
      mode: "plus",
      refusal: "unavailable_connection",
      savable: false,
      consequence: null,
    });
    expect(draft({ stored: stored([WEB], false), agentInactive: true }).mode).toBe("plus");
    // Not blocked: « plus » refused reads « exact ».
    expect(draft({ enforcedDefault: true })).toMatchObject({
      mode: "exact",
      refusal: "enforced_default",
      savable: true,
    });
    expect(draft({ connectionIds: [] })).toMatchObject({
      mode: "exact",
      refusal: "no_imposed_connection",
    });
  });

  it("refuses to save a set naming an unavailable connection until it is unticked", () => {
    const gone = { ...space, unavailableIds: [DB], stored: stored([WEB, DB], false) };
    expect(
      pinDraftVerdict({ ...gone, connectionIds: [WEB, DB], chosenMode: "exact" }),
    ).toMatchObject({ refusal: "unavailable_connection", savable: false });
    expect(pinDraftVerdict({ ...gone, connectionIds: [WEB], chosenMode: "exact" })).toMatchObject({
      refusal: null,
      savable: true,
      body: { connection_ids: [WEB] },
    });
  });

  it("refuses to save the pin of an agent inactive in the space", () => {
    expect(
      pinDraftVerdict({
        ...space,
        agentInactive: true,
        stored: stored([WEB], false),
        connectionIds: [WEB, DB],
        chosenMode: "exact",
      }),
    ).toMatchObject({ refusal: "inactive_agent", savable: false });
  });
});
