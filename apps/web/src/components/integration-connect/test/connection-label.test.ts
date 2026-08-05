// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the connection display/ownership helpers.
 *
 * `isConnectionOwnedBy` gates every owner-only control on the integration
 * detail page — delete, the share toggle, the OAuth renew CTA — against lists
 * that now contain org-shared connections owned by OTHER members. A false
 * positive renders a button whose request comes back 403/404; a false negative
 * hides a control from the person who owns the row. Both halves of the check
 * are load-bearing, so they are pinned here rather than left to the component.
 */

import { describe, it, expect } from "bun:test";
import { connectionDisplayLabel, isConnectionOwnedBy } from "../connection-label";

describe("connectionDisplayLabel", () => {
  it("renders the label verbatim when set", () => {
    expect(connectionDisplayLabel({ account_id: "acct-1", label: "work@acme.com" })).toBe(
      "work@acme.com",
    );
  });

  it("falls back to the account id when the label is absent or null", () => {
    expect(connectionDisplayLabel({ account_id: "acct-1" })).toBe("acct-1");
    expect(connectionDisplayLabel({ account_id: "acct-1", label: null })).toBe("acct-1");
  });
});

describe("isConnectionOwnedBy", () => {
  const mine = { owner_type: "user", owner_id: "user_1" } as const;

  it("matches the signed-in user's own connection", () => {
    expect(isConnectionOwnedBy(mine, "user_1")).toBe(true);
  });

  it("rejects another member's connection", () => {
    expect(isConnectionOwnedBy({ owner_type: "user", owner_id: "user_2" }, "user_1")).toBe(false);
  });

  it("rejects an end-user-owned row even when the ids collide", () => {
    // Nothing guarantees an `eu_…` id can never equal a user id, and only the
    // (type, id) pair identifies the owner — matching on the id alone would
    // hand a dashboard user the controls for an end-user's credential.
    expect(isConnectionOwnedBy({ owner_type: "end_user", owner_id: "user_1" }, "user_1")).toBe(
      false,
    );
  });

  it("rejects everything while the session is still loading", () => {
    // `useAuth().user` is undefined on first paint; owning nothing is the safe
    // default — controls appear once the session resolves, rather than
    // flashing enabled for rows that may not be the caller's.
    expect(isConnectionOwnedBy(mine, undefined)).toBe(false);
  });
});
