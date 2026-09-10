// SPDX-License-Identifier: Apache-2.0

/**
 * The ONE SPA rule that still reads a package's home space: which spaces the
 * "move" dialog may offer (RBAC spec §6.9).
 *
 * The write verdict is deliberately NOT tested here, because the SPA no longer
 * computes it: `home_writable` arrives on the package's own read, from
 * `homeWireForCaller` server-side, and the API integration suites are what pin
 * it. The hook this file used to exercise (`useHomeSpacePermission`) was that
 * second implementation and is gone.
 */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
});

const { writableDestinations } = await import("../../../lib/package-home.ts");

type Space = { id: string; name: string; permissions: string[] };

const space = (id: string, permissions: string[]): Space => ({ id, name: id, permissions });

describe("writableDestinations", () => {
  const spaces = [
    space("spc_home", ["skills:write"]),
    space("spc_other", ["skills:write"]),
    space("spc_reader", ["skills:read"]),
    space("spc_unjoined", []),
  ];

  it("offers the spaces where the caller may author this type, minus the current home", () => {
    expect(writableDestinations(spaces, "skill", "spc_home").map((s) => s.id)).toEqual([
      "spc_other",
    ]);
  });

  it("asks for the type's own permission, not any write", () => {
    // `agents:write` is a different resource: the same four spaces offer nothing.
    expect(writableDestinations(spaces, "agent", "spc_home")).toEqual([]);
  });

  it("offers every writable space when the home is null (catalog, or withheld)", () => {
    expect(writableDestinations(spaces, "skill", null).map((s) => s.id)).toEqual([
      "spc_home",
      "spc_other",
    ]);
  });

  it("offers nothing while the space list is loading", () => {
    expect(writableDestinations(undefined, "skill", "spc_home")).toEqual([]);
  });
});
