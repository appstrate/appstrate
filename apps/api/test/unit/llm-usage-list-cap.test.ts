// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { LLM_USAGE_LIST_MAX_LIMIT } from "../../src/services/state/runs.ts";

/**
 * `usage.list` clamps at this many rows, and `@appstrate/module-ee` sizes
 * `EE_RECONCILIATION_BATCH_SIZE + EE_RECONCILIATION_REPLAY_WINDOW` against the
 * same number (`LEDGER_LIST_MAX_LIMIT`, pinned by the module's own
 * `test/unit/env.test.ts`). Lowering the clamp here without lowering the
 * module's ceiling would let the module accept a sum the read then truncates —
 * the silent forward-slice loss #1328 fixed. The licence boundary forbids
 * importing the module's constant, so the contract value is pinned on both
 * sides instead.
 */
describe("usage.list ceiling", () => {
  it("is the 1000-row module-contract value", () => {
    expect(LLM_USAGE_LIST_MAX_LIMIT).toBe(1000);
  });
});
