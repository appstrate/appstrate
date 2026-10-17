// SPDX-License-Identifier: Apache-2.0

/**
 * The admin pin PUT replaces the whole pin, its mode included: an absent
 * `allow_additional_connections` reads « exact ». Every body the SPA sends therefore names the flag,
 * and every write rewrites the stored set, so a set naming a connection no longer shared (or the
 * pin of an agent inactive in the space) cannot be saved at all.
 */

import { describe, expect, it } from "bun:test";
import {
  additionsRefusal,
  adminPinBody,
  initialPinDraft,
  pinDraftVerdict,
  pinMode,
} from "../admin-pin-payload";

const WEB = "11111111-1111-4111-8111-111111111111";
const DB = "22222222-2222-4222-8222-222222222222";

describe("adminPinBody", () => {
  it("always names the additions flag, closed as open", () => {
    expect(adminPinBody({ connection_ids: [WEB], allow_additional_connections: false })).toEqual({
      connection_ids: [WEB],
      allow_additional_connections: false,
    });
    expect(adminPinBody({ connection_ids: [WEB, DB], allow_additional_connections: true })).toEqual(
      { connection_ids: [WEB, DB], allow_additional_connections: true },
    );
    expect(adminPinBody({ connection_ids: [], allow_additional_connections: false })).toEqual({
      connection_ids: [],
      allow_additional_connections: false,
    });
  });
});

describe("pinMode", () => {
  it("reads « exact » off a closed pin, the default, and « plus » off an open one", () => {
    expect(pinMode({ allow_additional_connections: false })).toBe("exact");
    expect(pinMode({ allow_additional_connections: true })).toBe("plus");
  });
});

describe("additionsRefusal", () => {
  const closed = (connection_ids: string[] | null) => ({
    connection_ids,
    allow_additional_connections: false,
  });
  const opened = (connection_ids: string[]) => ({
    connection_ids,
    allow_additional_connections: true,
  });
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

  it("lets a « plus » pin go back to « exact », enforced default or not", () => {
    expect(additionsRefusal(opened([WEB]), { ...space, enforcedDefault: true })).toBeNull();
  });

  it("refuses either change while the stored set names an unavailable connection", () => {
    // The change rewrites the stored set, which the server refuses (404) over that member.
    const gone = { ...space, unavailableIds: [DB] };
    expect(additionsRefusal(closed([WEB, DB]), gone)).toBe("unavailable_connection");
    expect(additionsRefusal(opened([WEB, DB]), gone)).toBe("unavailable_connection");
    expect(additionsRefusal(opened([WEB]), gone)).toBeNull();
    expect(additionsRefusal(closed([WEB]), gone)).toBeNull();
  });

  it("refuses either change first while the pin's agent is not active in the space", () => {
    // The change rewrites the pin, which the server refuses (404) for an agent not active there.
    const inactive = { ...space, agentInactive: true };
    expect(additionsRefusal(closed([WEB]), inactive)).toBe("inactive_agent");
    expect(additionsRefusal(opened([WEB]), inactive)).toBe("inactive_agent");
    expect(additionsRefusal(closed([]), inactive)).toBe("inactive_agent");
    expect(
      additionsRefusal(opened([WEB, DB]), {
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

  it("names whom saving affects by the move it makes", () => {
    const verdict = (from: boolean, ids: string[], to: "exact" | "plus") =>
      pinDraftVerdict({ ...space, stored: stored([WEB], from), connectionIds: ids, chosenMode: to })
        .consequence;
    expect(verdict(false, [DB], "exact")).toBe("clears_choices");
    expect(verdict(false, [WEB], "plus")).toBe("clears_choices");
    expect(verdict(true, [WEB], "exact")).toBe("clears_choices_and_schedules");
    expect(verdict(true, [WEB, DB], "plus")).toBeNull();
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
