// SPDX-License-Identifier: Apache-2.0

/**
 * `connectionActions`: the write controls a row offers, which the edit services enforce. The owner
 * renames, renews an identified row and shares; a governor of the request space withdraws a
 * colleague's row shared here and renames one scoped here; a credential bound to a space renames
 * and renews rows of it only.
 */

import { describe, it, expect } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  connectionActions,
  withinSpaces,
  type ConnectionCaller,
} from "../../../src/services/connection-reach.ts";
import { testCaller } from "../../helpers/connection-shares.ts";

const OWNER = "user_1";
const COLLEAGUE = "user_2";
const HERE = "spc_here";
const ELSEWHERE = "spc_elsewhere";

// `default`: the account is not identified, so the rows hold no `reconnect` unless a test says so.
const orgRow = (userId = OWNER) => ({
  orgId: "org_1",
  userId,
  endUserId: null,
  spaceId: null,
  accountId: "default",
});
const spaceRow = (userId = OWNER, spaceId = HERE) => ({
  orgId: "org_1",
  userId,
  endUserId: null,
  spaceId,
  accountId: "default",
});

function reader(overrides: Partial<ConnectionCaller> = {}): ConnectionCaller {
  return testCaller(
    { kind: "person", binding: null, actor: { type: "user", id: OWNER } },
    {
      spaceId: HERE,
      ...overrides,
    },
  );
}

describe("connectionActions", () => {
  it("offers all-spaces consent only to its org-admin owner with the credential grant", () => {
    expect(
      connectionActions(orgRow(), reader({ canShareAllSpaces: () => true }), false, "admin"),
    ).toContain("share_all_spaces");
    for (const role of ["member", "guest"] as const) {
      expect(
        connectionActions(orgRow(), reader({ canShareAllSpaces: () => true }), false, role),
      ).not.toContain("share_all_spaces");
    }
    expect(
      connectionActions(orgRow(), reader({ canShareAllSpaces: () => false }), false, "owner"),
    ).not.toContain("share_all_spaces");
    expect(
      connectionActions(spaceRow(), reader({ canShareAllSpaces: () => true }), false, "owner"),
    ).not.toContain("share_all_spaces");
    expect(
      connectionActions(
        orgRow(COLLEAGUE),
        reader({ canShareAllSpaces: () => true }),
        false,
        "owner",
      ),
    ).not.toContain("share_all_spaces");
  });
  it("evaluates all-space consent in the connection's organization", () => {
    const caller = reader({ canShareAllSpaces: (orgId) => orgId !== "previewed" });
    expect(
      connectionActions({ ...orgRow(), orgId: "previewed" }, caller, false, "owner"),
    ).not.toContain("share_all_spaces");
    expect(connectionActions(orgRow(), caller, false, "owner")).toContain("share_all_spaces");
  });
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
    const row = {
      orgId: "org_1",
      userId: null,
      endUserId: "eu_1",
      spaceId: HERE,
      accountId: "default",
    };
    const bound = reader({
      principal: {
        kind: "delegated",
        actor: endUser,
        binding: { orgId: "org_1", spaceIds: [HERE] },
      },
    });
    expect(connectionActions(row, bound, false)).toEqual(["rename"]);
  });

  it("a credential bound to a space renames only rows scoped to it, and still shares", () => {
    const bound = reader({
      principal: {
        kind: "delegated",
        actor: { type: "user", id: OWNER },
        binding: { orgId: "org_1", spaceIds: [HERE] },
      },
    });
    expect(connectionActions(spaceRow(), bound, false)).toEqual(["rename", "share"]);
    expect(connectionActions(orgRow(), bound, false)).toEqual(["share"]);
    expect(connectionActions(spaceRow(OWNER, ELSEWHERE), bound, false)).toEqual(["share"]);
  });

  it("a person bound to spaces (a confined credential) is never offered all-spaces consent", () => {
    const bound = reader({
      principal: {
        kind: "person",
        actor: { type: "user", id: OWNER },
        binding: { orgId: "org_1", spaceIds: [HERE] },
      },
      canShareAllSpaces: () => true,
    });
    expect(connectionActions(orgRow(), bound, false, "owner")).toEqual(["share"]);
    expect(connectionActions(spaceRow(), bound, false, "owner")).toEqual(["rename", "share"]);
  });

  it.each([HERE, null])(
    "an unpinned delegate renews only space rows (list space: %s)",
    (spaceId) => {
      const unpinned = reader({
        spaceId,
        principal: {
          kind: "delegated",
          actor: { type: "user", id: OWNER },
          binding: { orgId: "org_1", spaceIds: null },
        },
      });
      const orgConnection = { ...orgRow(), accountId: "alice@example.com" };
      const spaceConnection = { ...orgConnection, spaceId: HERE };
      expect(connectionActions(orgConnection, unpinned, false)).toEqual(["rename", "share"]);
      expect(connectionActions(spaceConnection, unpinned, false)).toContain("reconnect");
    },
  );
});

describe("withinSpaces", () => {
  const render = (clause: ReturnType<typeof withinSpaces>) =>
    clause === undefined ? undefined : new PgDialect().sqlToQuery(clause).sql;
  const inSpace = (spaceId: string) => sql`space_id = ${spaceId}`;

  it("bounds nothing for no list, matches nothing for an empty one", () => {
    expect(withinSpaces(null, inSpace)).toBeUndefined();
    expect(render(withinSpaces([], inSpace))).toBe("FALSE");
  });

  it("holds for one of the listed spaces", () => {
    expect(render(withinSpaces([HERE, ELSEWHERE], inSpace))).toBe(
      "(space_id = $1 or space_id = $2)",
    );
  });
});

describe("connectionActions: reconnect", () => {
  const identified = { ...orgRow(), accountId: "alice@example.com" };

  it("gives the owner reconnect on an identified row, whatever its health", () => {
    expect(connectionActions(identified, reader(), false)).toEqual([
      "rename",
      "reconnect",
      "share",
    ]);
  });

  it("withholds it from a row whose upstream account is not identified", () => {
    expect(connectionActions({ ...orgRow(), accountId: "default" }, reader(), false)).toEqual([
      "rename",
      "share",
    ]);
  });

  it("never gives it to a governor on a colleague's row", () => {
    const row = { ...spaceRow(COLLEAGUE), accountId: "bob@example.com" };
    expect(connectionActions(row, reader({ governs: true }), true)).not.toContain("reconnect");
  });

  it("follows the bound credential's write rule: only a row scoped to one of its spaces", () => {
    const bound = reader({
      principal: {
        kind: "delegated",
        actor: { type: "user", id: OWNER },
        binding: { orgId: "org_1", spaceIds: [HERE] },
      },
    });
    expect(connectionActions(identified, bound, false)).not.toContain("reconnect");
    expect(
      connectionActions({ ...spaceRow(), accountId: "alice@example.com" }, bound, false),
    ).toContain("reconnect");
  });
});
