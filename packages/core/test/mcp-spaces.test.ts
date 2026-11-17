// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { spaceIdRefusal } from "../src/mcp-spaces.ts";

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
