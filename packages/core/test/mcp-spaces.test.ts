// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { describeSpace, spaceIdRefusal } from "../src/mcp-spaces.ts";

describe("describeSpace", () => {
  it("names the space, its id and the caller's role there", () => {
    expect(describeSpace({ id: "spc_a", name: "Alpha", role: "admin" })).toBe(
      "Alpha (`spc_a`, role admin)",
    );
    expect(describeSpace({ id: "spc_a", name: "Alpha", role: "admin", personal: false })).toBe(
      "Alpha (`spc_a`, role admin)",
    );
  });

  it("marks the caller's own personal space", () => {
    expect(describeSpace({ id: "spc_p", name: "Perso", role: "admin", personal: true })).toBe(
      "Perso (`spc_p`, role admin, your personal space)",
    );
  });
});

describe("spaceIdRefusal", () => {
  const spaces = [
    { id: "spc_a", name: "Alpha", role: "admin" },
    { id: "spc_b", name: "Beta", role: "viewer" },
  ];

  it("asks for the argument and lists the spaces when it is missing", () => {
    for (const missing of [undefined, null]) {
      expect(spaceIdRefusal(spaces, missing)).toEqual({
        code: "missing_argument",
        error:
          "space_id is required. Spaces you can act in: Alpha (`spc_a`, role admin); Beta (`spc_b`, role viewer).",
        arguments: ["space_id"],
        accepted: ["spc_a", "spc_b"],
      });
    }
  });

  it("refuses an id that is not a reachable space, whatever its type", () => {
    for (const unknown of ["spc_nope", 7]) {
      const refusal = spaceIdRefusal(spaces, unknown);
      expect(refusal?.code).toBe("unknown_space");
      expect(refusal?.error).toStartWith(
        `Unknown space_id: ${String(unknown)}. Spaces you can act in:`,
      );
      expect(refusal?.accepted).toEqual(["spc_a", "spc_b"]);
    }
  });

  it("accepts a reachable space", () => {
    expect(spaceIdRefusal(spaces, "spc_b")).toBeUndefined();
  });
});
