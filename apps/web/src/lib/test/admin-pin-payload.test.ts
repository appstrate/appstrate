// SPDX-License-Identifier: Apache-2.0

/**
 * The admin pin PUT replaces the whole pin, its mode included: an absent
 * `allow_additional_connections` reads « exact ». Every body the SPA sends therefore names the flag,
 * and a mode change rewrites the stored set, so a set naming a connection no longer shared cannot
 * change mode in either direction.
 */

import { describe, expect, it } from "bun:test";
import { additionsRefusal, adminPinBody, pinMode, switchedModeBody } from "../admin-pin-payload";

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

describe("switchedModeBody", () => {
  it("names the other mode's flag and rewrites the stored set as it is, in its order", () => {
    const stored = {
      agent_package_id: "@acme/ops",
      integration_package_id: "@acme/drive",
      connection_ids: [DB, WEB],
      allow_additional_connections: false,
      createdAt: "2026-10-17T10:00:00Z",
      updatedAt: "2026-10-17T10:00:00Z",
    };
    expect(switchedModeBody(stored)).toEqual({
      connection_ids: [DB, WEB],
      allow_additional_connections: true,
    });
    expect(switchedModeBody({ ...stored, allow_additional_connections: true })).toEqual({
      connection_ids: [DB, WEB],
      allow_additional_connections: false,
    });
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
