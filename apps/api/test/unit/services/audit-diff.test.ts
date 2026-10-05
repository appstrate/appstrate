// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { auditDiff } from "../../../src/services/audit.ts";

describe("auditDiff", () => {
  it("records only the fields whose value changed, absent as null", () => {
    expect(
      auditDiff({
        name: ["a", "b"],
        enabled: [true, true],
        proxyId: [undefined, "prx_1"],
        modelId: ["m", null],
      }),
    ).toEqual({
      before: { name: "a", proxyId: null, modelId: "m" },
      after: { name: "b", proxyId: "prx_1", modelId: null },
    });
  });

  it("skips a field the write did not touch", () => {
    expect(auditDiff({ name: ["a", undefined], timezone: ["UTC", "Europe/Paris"] })).toEqual({
      before: { timezone: "UTC" },
      after: { timezone: "Europe/Paris" },
    });
  });

  it("compares structured values deeply and returns null when nothing moved", () => {
    expect(
      auditDiff({
        input: [
          { a: 1, b: [1, 2] },
          { b: [1, 2], a: 1 },
        ],
        modelId: [null, undefined],
        proxyId: [undefined, null],
      }),
    ).toBeNull();
  });
});
