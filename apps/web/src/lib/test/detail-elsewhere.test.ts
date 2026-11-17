// SPDX-License-Identifier: Apache-2.0

/**
 * A detail opened in « Tous les espaces » on a resource the hidden working space cannot read
 * reopens in a reached space holding it, and says it is unavailable only when none does.
 */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { detailElsewhere, isUnreadableHere, nextSpaceToTry, placedSpaceIds } =
  await import("../detail-elsewhere.ts");
const { ApiError } = await import("../../api/client.ts");

const rows = [
  { id: "@acme/a", spaceIds: ["spc_b", "spc_c"] },
  { id: "@acme/here", spaceIds: ["spc_a"] },
];
const all = () => true;

describe("detailElsewhere", () => {
  it("waits while the read across spaces has not answered", () => {
    expect(detailElsewhere(undefined, "@acme/a", "/agents/@acme/a", "spc_a", all)).toBeUndefined();
  });

  it("reopens the page in the first space holding it, entering it", () => {
    expect(detailElsewhere(rows, "@acme/a", "/agents/@acme/a", "spc_a", all)).toBe(
      "/agents/@acme/a?enterSpace=spc_b",
    );
  });

  it("keeps the query and the hash the page was opened with", () => {
    expect(
      detailElsewhere(
        rows,
        "@acme/a",
        "/agents/@acme/a?agentSettings=connections#settings",
        "spc_a",
        all,
      ),
    ).toBe("/agents/@acme/a?agentSettings=connections&enterSpace=spc_b#settings");
  });

  it("says unavailable when no reached space holds it", () => {
    expect(detailElsewhere(rows, "@acme/gone", "/skills/@acme/gone", "spc_a", all)).toBeNull();
    expect(detailElsewhere([], "@acme/a", "/agents/@acme/a", "spc_a", all)).toBeNull();
  });

  it("never reopens in the working space, which just refused it", () => {
    expect(detailElsewhere(rows, "@acme/here", "/agents/@acme/here", "spc_a", all)).toBeNull();
  });

  it("tries the next listed space when the working one is listed and still refused", () => {
    expect(detailElsewhere(rows, "@acme/a", "/agents/@acme/a", "spc_b", all)).toBe(
      "/agents/@acme/a?enterSpace=spc_c",
    );
    // The last listed space refused too: nothing is left, the page says so.
    expect(detailElsewhere(rows, "@acme/a", "/agents/@acme/a", "spc_c", all)).toBeNull();
  });

  it("skips a space that cannot be entered", () => {
    const open = (spaceId: string) => spaceId !== "spc_b";
    expect(detailElsewhere(rows, "@acme/a", "/agents/@acme/a", "spc_a", open)).toBe(
      "/agents/@acme/a?enterSpace=spc_c",
    );
  });

  it("has nothing to move from before a space is resolved", () => {
    expect(detailElsewhere(rows, "@acme/a", "/agents/@acme/a", null, all)).toBeNull();
  });
});

describe("nextSpaceToTry", () => {
  it("moves forward only, so a chain of refusals ends", () => {
    const listed = ["spc_1", "spc_2", "spc_3"];
    expect(nextSpaceToTry(listed, "spc_x", all)).toBe("spc_1");
    expect(nextSpaceToTry(listed, "spc_1", all)).toBe("spc_2");
    expect(nextSpaceToTry(listed, "spc_2", all)).toBe("spc_3");
    expect(nextSpaceToTry(listed, "spc_3", all)).toBeUndefined();
  });
});

describe("placedSpaceIds", () => {
  it("lists the active placements first, then the inactive ones, never `none`", () => {
    expect(
      placedSpaceIds([
        { space_id: "spc_off", state: "inactive" },
        { space_id: "spc_none", state: "none" },
        { space_id: "spc_on", state: "active" },
      ]),
    ).toEqual(["spc_on", "spc_off"]);
  });
});

describe("isUnreadableHere", () => {
  const apiError = (status: number) => new ApiError("not_found", "refused", status);

  it("is a 403, a 404, or a 404 read as nothing", () => {
    expect(isUnreadableHere(apiError(404))).toBe(true);
    expect(isUnreadableHere(apiError(403))).toBe(true);
    expect(isUnreadableHere(null)).toBe(true);
  });

  it("is not a failure of another kind", () => {
    expect(isUnreadableHere(apiError(500))).toBe(false);
    expect(isUnreadableHere(new Error("network"))).toBe(false);
  });
});
