// SPDX-License-Identifier: Apache-2.0

/**
 * A detail opened in « Tous les espaces » on a resource the hidden working space cannot read
 * reopens in a reached space holding it, and says it is unavailable only when none does.
 */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { detailElsewhere, isUnreadableHere } = await import("../detail-elsewhere.ts");
const { ApiError } = await import("../../api/client.ts");

describe("detailElsewhere", () => {
  const target = "/agents/@acme/a?agentSettings=connections#settings";
  const placements = ["spc_b", "spc_c"];
  const open = () => true;
  it("retains the page, query and hash when entering the next readable placement", () => {
    expect(detailElsewhere(placements, target, "spc_a", open)).toBe(
      "/agents/@acme/a?agentSettings=connections&enterSpace=spc_b#settings",
    );
    const inC = "/agents/@acme/a?agentSettings=connections&enterSpace=spc_c#settings";
    expect(detailElsewhere(placements, target, "spc_b", open)).toBe(inC);
    expect(detailElsewhere(placements, target, "spc_a", (id) => id !== "spc_b")).toBe(inC);
  });

  it("stops after the last refusal, when there are no placements, or before the space resolves", () => {
    expect(detailElsewhere(placements, target, "spc_c", open)).toBeNull();
    expect(detailElsewhere([], target, "spc_a", open)).toBeNull();
    expect(detailElsewhere(placements, target, null, open)).toBeNull();
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
