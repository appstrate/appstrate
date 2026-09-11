// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { LEDGER_LIST_MAX_LIMIT } from "@appstrate/module-ee";
import { LLM_USAGE_LIST_MAX_LIMIT } from "../../src/services/state/runs.ts";

/**
 * `@appstrate/module-ee` sizes `EE_RECONCILIATION_BATCH_SIZE +
 * EE_RECONCILIATION_REPLAY_WINDOW` against the platform's `usage.list` ceiling
 * and refuses to boot above it, but declares that ceiling as a literal of its
 * own. Lowering the platform's clamp without lowering the module's would let
 * the module accept a sum the read then truncates — the silent forward-slice
 * loss #1328 fixed. Two independently declared values, so either one moving
 * fails this.
 *
 * The read runs this way only: `apps/api` may import the module, the reverse
 * is what the licence boundary forbids.
 */
describe("ledger list cap parity", () => {
  it("EE's declared ledger ceiling is the platform's own clamp", () => {
    expect(LEDGER_LIST_MAX_LIMIT).toBe(LLM_USAGE_LIST_MAX_LIMIT);
  });
});
