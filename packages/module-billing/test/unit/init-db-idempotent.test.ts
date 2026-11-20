// SPDX-License-Identifier: Apache-2.0

/**
 * `initBillingDb` runs once per process, but nothing in the module contract stops a second
 * call. A call that overwrote the handle would leave the first pool's sockets open with
 * no reference left to end them, and `shutdown()` would close only the last one.
 */

import { describe, expect, it } from "bun:test";
import { getBillingDb, initBillingDb } from "../../src/db.ts";

const DATABASE_URL = process.env.DATABASE_URL!;

describe("initBillingDb", () => {
  it("keeps the open pool when called again for the same database", () => {
    initBillingDb(DATABASE_URL);
    const first = getBillingDb();
    initBillingDb(DATABASE_URL);
    expect(getBillingDb()).toBe(first);
  });

  it("refuses a second database rather than stranding the first pool", () => {
    // Opens the pool itself rather than inheriting the one the test above left: a
    // precondition that is another test's side effect depends on runner order.
    initBillingDb(DATABASE_URL);
    const before = getBillingDb();
    expect(() => initBillingDb("postgres://elsewhere:5432/other")).toThrow(
      /different DATABASE_URL than the open pool/,
    );
    expect(getBillingDb()).toBe(before);
  });
});
