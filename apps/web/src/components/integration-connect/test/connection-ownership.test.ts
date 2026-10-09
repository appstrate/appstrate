// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the connection ownership helper.
 *
 * `isConnectionOwnedBy` gates every owner-only control on the integration
 * detail page — delete, the share editor, the OAuth renew CTA — against lists
 * that contain connections OTHER members share into the space. A false
 * positive renders a button whose request comes back 403/404; a false negative
 * hides a control from the person who owns the row. Both halves of the check
 * are load-bearing, so they are pinned here rather than left to the component.
 */

import { describe, it, expect } from "bun:test";
import {
  connectionRowGrants,
  isConnectionOwnedBy,
  isSharedInSpace,
  withSpaceShare,
} from "../connection-ownership";

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

describe("connectionRowGrants", () => {
  const base = {
    isOwn: false,
    isShared: false,
    scope: "org",
    canConnect: true,
    canConfigure: false,
  } as const;

  it("gives the owner rename and the share targets, never the governor's withdrawal", () => {
    expect(connectionRowGrants({ ...base, isOwn: true, isShared: true })).toEqual({
      canRename: true,
      canEditShares: true,
      canUnshareHere: false,
    });
  });

  it("gives an owner who governs the space the same, not a second door", () => {
    expect(
      connectionRowGrants({ ...base, isOwn: true, isShared: true, canConfigure: true }),
    ).toEqual({ canRename: true, canEditShares: true, canUnshareHere: false });
  });

  it("lets a governor withdraw a colleague's row from this space, never share one", () => {
    // Sharing is the owner's consent; `integrations:configure` only unshares here.
    expect(connectionRowGrants({ ...base, isShared: true, canConfigure: true })).toMatchObject({
      canEditShares: false,
      canUnshareHere: true,
    });
    expect(connectionRowGrants({ ...base, isShared: false, canConfigure: true })).toMatchObject({
      canEditShares: false,
      canUnshareHere: false,
    });
  });

  it("lets a governor rename a space-scoped row, never an org-scoped one", () => {
    // An org-scoped row spans spaces: the API refuses a governor's rename (403).
    expect(
      connectionRowGrants({ ...base, isShared: true, canConfigure: true, scope: "space" })
        .canRename,
    ).toBe(true);
    expect(
      connectionRowGrants({ ...base, isShared: true, canConfigure: true, scope: "org" }).canRename,
    ).toBe(false);
  });

  it("gives a plain member nothing on a colleague's shared row", () => {
    expect(connectionRowGrants({ ...base, isShared: true, scope: "space" })).toEqual({
      canRename: false,
      canEditShares: false,
      canUnshareHere: false,
    });
  });

  it("gives nothing without integrations:connect, whoever owns the row", () => {
    const denied = { canRename: false, canEditShares: false, canUnshareHere: false };
    expect(
      connectionRowGrants({ ...base, isOwn: true, isShared: true, canConnect: false }),
    ).toEqual(denied);
    expect(
      connectionRowGrants({
        ...base,
        isShared: true,
        scope: "space",
        canConnect: false,
        canConfigure: true,
      }),
    ).toEqual(denied);
  });
});

describe("isSharedInSpace", () => {
  it("reads the current space in the owner's full set", () => {
    expect(isSharedInSpace({ shared_space_ids: ["spc_b", "spc_a"] }, "spc_a")).toBe(true);
    expect(isSharedInSpace({ shared_space_ids: ["spc_b"] }, "spc_a")).toBe(false);
  });

  it("is false without a current space", () => {
    expect(isSharedInSpace({ shared_space_ids: ["spc_a"] }, null)).toBe(false);
  });
});

describe("withSpaceShare", () => {
  it("adds the space to the owner's set, keeping the other targets", () => {
    expect(withSpaceShare(["spc_b"], "spc_a", true)).toEqual(["spc_b", "spc_a"]);
    expect(withSpaceShare(["spc_a"], "spc_a", true)).toEqual(["spc_a"]);
  });

  it("removes only that space", () => {
    expect(withSpaceShare(["spc_b", "spc_a"], "spc_a", false)).toEqual(["spc_b"]);
  });

  it("sends an empty set for a governor withdrawing a colleague's share here", () => {
    // A non-owner sees `[current space]`; the API accepts only that minus the space.
    expect(withSpaceShare(["spc_a"], "spc_a", false)).toEqual([]);
  });
});
