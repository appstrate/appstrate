// SPDX-License-Identifier: Apache-2.0

// Boot refusal while `oauth_clients.self_service` still contradicts the
// `metadata` JSON key drizzle `0057` left behind — i.e. while
// `scripts/migration/0011-oauth-clients-self-service-fold.sql` has not run.
//
// The count is injected, so these run without a database; the live probe is
// exercised against seeded rows in
// `../integration/db/oauth-client-self-service-fold-migration.test.ts`.
// See docs/NO_TRANSITIONAL_CODE.md §5 — this check must never repair.

import { describe, it, expect } from "bun:test";
import {
  assertNoPendingDataScripts,
  PENDING_DATA_SCRIPTS,
} from "../../src/lib/boot-guards/pending-data-scripts.ts";

const ENTRY = PENDING_DATA_SCRIPTS.find((e) => e.after === "0057")!;
const guard = (n: number) =>
  assertNoPendingDataScripts(null, [{ ...ENTRY, pending: async () => n }]);

describe("the 0011 entry of PENDING_DATA_SCRIPTS", () => {
  it("returns without throwing once no row is left to fold", async () => {
    expect(await guard(0)).toBeUndefined();
  });

  it("refuses to boot, naming the pending count and the operator script", async () => {
    // The operator has to know how many clients are exposed before deciding how
    // urgently to act, so the count is part of the message and not just the trigger.
    await expect(guard(7)).rejects.toThrow(
      /0011-oauth-clients-self-service-fold\.sql \(after drizzle 0057\): 7 pending[\s\S]*Security control off[\s\S]*apply scripts\/migration\/0011-oauth-clients-self-service-fold\.sql to this database[\s\S]*Refusing to boot/,
    );
  });

  it("propagates a failing probe instead of assuming the fold ran", async () => {
    const boom = new Error("connection terminated");
    await expect(
      assertNoPendingDataScripts(null, [{ ...ENTRY, pending: () => Promise.reject(boom) }]),
    ).rejects.toThrow(boom);
  });
});
