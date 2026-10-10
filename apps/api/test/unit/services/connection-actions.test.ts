// SPDX-License-Identifier: Apache-2.0

/**
 * `connectionActions`: the write controls a row offers, as the share and rename services enforce
 * them. The owner renames and shares; a governor of the request space withdraws a colleague's row
 * shared here and renames one scoped here; a credential bound to a space renames rows of it only.
 */

import { describe, it, expect } from "bun:test";
import {
  connectionActions,
  type ConnectionReader,
} from "../../../src/services/connection-reach.ts";

const OWNER = "user_1";
const COLLEAGUE = "user_2";
const HERE = "spc_here";
const ELSEWHERE = "spc_elsewhere";

const orgRow = (userId = OWNER) => ({ userId, endUserId: null, spaceId: null });
const spaceRow = (userId = OWNER, spaceId = HERE) => ({ userId, endUserId: null, spaceId });

function reader(overrides: Partial<ConnectionReader> = {}): ConnectionReader {
  return {
    principal: { kind: "person", actor: { type: "user", id: OWNER } },
    spaceId: HERE,
    canConnect: true,
    governs: false,
    ...overrides,
  };
}

describe("connectionActions", () => {
  it("gives the owner rename and share, never the governor's withdrawal", () => {
    expect(connectionActions(orgRow(), reader(), true)).toEqual(["rename", "share"]);
  });

  it("gives an owner who governs the space the same, not a second door", () => {
    expect(connectionActions(orgRow(), reader({ governs: true }), true)).toEqual([
      "rename",
      "share",
    ]);
  });

  it("gives the owner the same on the account surface", () => {
    expect(connectionActions(spaceRow(), reader({ spaceId: null }), false)).toEqual([
      "rename",
      "share",
    ]);
  });

  it("lets a governor withdraw a colleague's row shared here, never share one", () => {
    const governor = reader({ governs: true });
    expect(connectionActions(orgRow(COLLEAGUE), governor, true)).toEqual(["unshare_here"]);
    expect(connectionActions(orgRow(COLLEAGUE), governor, false)).toEqual([]);
  });

  it("lets a governor rename a row scoped here, never an org-scoped one or another space's", () => {
    const governor = reader({ governs: true });
    expect(connectionActions(spaceRow(COLLEAGUE), governor, true)).toEqual([
      "rename",
      "unshare_here",
    ]);
    expect(connectionActions(orgRow(COLLEAGUE), governor, true)).not.toContain("rename");
    expect(connectionActions(spaceRow(COLLEAGUE, ELSEWHERE), governor, false)).toEqual([]);
  });

  it("gives a governor nothing on a colleague's row without a request space", () => {
    expect(
      connectionActions(spaceRow(COLLEAGUE), reader({ governs: true, spaceId: null }), true),
    ).toEqual([]);
  });

  it("gives a plain member nothing on a colleague's shared row", () => {
    expect(connectionActions(spaceRow(COLLEAGUE), reader(), true)).toEqual([]);
  });

  it("gives nothing without integrations:connect, whoever owns the row", () => {
    expect(connectionActions(orgRow(), reader({ canConnect: false }), true)).toEqual([]);
    expect(
      connectionActions(spaceRow(COLLEAGUE), reader({ canConnect: false, governs: true }), true),
    ).toEqual([]);
  });

  it("never offers share on an end user's row", () => {
    const endUser = { type: "end_user" as const, id: "eu_1" };
    const row = { userId: null, endUserId: "eu_1", spaceId: HERE };
    const bound = reader({
      principal: { kind: "delegated", actor: endUser, orgId: "org_1", spaceId: HERE },
    });
    expect(connectionActions(row, bound, false)).toEqual(["rename"]);
  });

  it("a credential bound to a space renames only rows scoped to it, and still shares", () => {
    const bound = reader({
      principal: {
        kind: "delegated",
        actor: { type: "user", id: OWNER },
        orgId: "org_1",
        spaceId: HERE,
      },
    });
    expect(connectionActions(spaceRow(), bound, false)).toEqual(["rename", "share"]);
    expect(connectionActions(orgRow(), bound, false)).toEqual(["share"]);
    expect(connectionActions(spaceRow(OWNER, ELSEWHERE), bound, false)).toEqual(["share"]);
  });

  it("a delegated credential pinning no space renames like the person", () => {
    const unpinned = reader({
      principal: {
        kind: "delegated",
        actor: { type: "user", id: OWNER },
        orgId: "org_1",
        spaceId: null,
      },
    });
    expect(connectionActions(orgRow(), unpinned, false)).toEqual(["rename", "share"]);
  });
});
