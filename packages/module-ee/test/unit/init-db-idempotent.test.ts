// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * `initEeDb` runs once per process, but nothing in the module contract stops a second
 * call. A call that overwrote the handle would leave the first pool's sockets open with
 * no reference left to end them, and `shutdown()` would close only the last one.
 */

import { describe, expect, it } from "bun:test";
import { getEeDb, initEeDb } from "../../src/db.ts";

const DATABASE_URL = process.env.DATABASE_URL!;

describe("initEeDb", () => {
  it("keeps the open pool when called again for the same database", () => {
    initEeDb(DATABASE_URL);
    const first = getEeDb();
    initEeDb(DATABASE_URL);
    expect(getEeDb()).toBe(first);
  });

  it("refuses a second database rather than stranding the first pool", () => {
    // Opens the pool itself rather than inheriting the one the test above left: a
    // precondition that is another test's side effect depends on runner order.
    initEeDb(DATABASE_URL);
    const before = getEeDb();
    expect(() => initEeDb("postgres://elsewhere:5432/other")).toThrow(
      /different DATABASE_URL than the open pool/,
    );
    expect(getEeDb()).toBe(before);
  });
});
