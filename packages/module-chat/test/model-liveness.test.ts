// SPDX-License-Identifier: Apache-2.0

/**
 * The single liveness gate shared by the server picker (`llm.ts`) and the two
 * browser call sites (`ui/index.tsx` reconcile, `ui/model-select.tsx`). What is
 * worth pinning is the wire convention, not the boolean: `needs_reconnection`
 * is optional on `/api/models` and absent on an instance older than the field,
 * which must read as live rather than as a missing-property falsy accident.
 */

import { describe, expect, it } from "bun:test";
import { isModelLive } from "../src/model-liveness.ts";

describe("isModelLive", () => {
  it("treats an absent flag as live", () => {
    expect(isModelLive({})).toBe(true);
  });

  it("only `true` is dead", () => {
    expect(isModelLive({ needs_reconnection: false })).toBe(true);
    expect(isModelLive({ needs_reconnection: true })).toBe(false);
  });
});
