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

const rows = [
  { id: "@acme/a", spaceIds: ["spc_b", "spc_c"] },
  { id: "@acme/here", spaceIds: ["spc_a"] },
];

describe("detailElsewhere", () => {
  it("waits while the spanning list has not answered", () => {
    expect(detailElsewhere(undefined, "@acme/a", "/agents/@acme/a", "spc_a")).toBeUndefined();
  });

  it("reopens the page in the first space holding it, entering it", () => {
    expect(detailElsewhere(rows, "@acme/a", "/agents/@acme/a", "spc_a")).toBe(
      "/agents/@acme/a?enterSpace=spc_b",
    );
  });

  it("says unavailable when no reached space holds it", () => {
    expect(detailElsewhere(rows, "@acme/gone", "/skills/@acme/gone", "spc_a")).toBeNull();
    expect(detailElsewhere([], "@acme/a", "/agents/@acme/a", "spc_a")).toBeNull();
  });

  it("never reopens in the working space, which just refused it", () => {
    expect(detailElsewhere(rows, "@acme/here", "/agents/@acme/here", "spc_a")).toBeNull();
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
