// SPDX-License-Identifier: Apache-2.0

/**
 * `bun --hot` re-evaluates the client module inside the same process; a second
 * PGlite on the data directory the first still holds corrupts it. A query
 * string makes Bun evaluate the module afresh, which is what a hot reload does.
 */

import { describe, it, expect } from "bun:test";

type ClientModule = typeof import("../src/client.ts");

const describeEmbedded = describe.skipIf(!!process.env.DATABASE_URL);

describeEmbedded("PGlite client under bun --hot", () => {
  it("reuses the open instance when the module is re-evaluated", async () => {
    const path = "../src/client.ts";
    const first = (await import(`${path}?reeval=1`)) as ClientModule;
    const second = (await import(`${path}?reeval=2`)) as ClientModule;

    expect(first.getPGliteClient()).not.toBeNull();
    expect(second.getPGliteClient()).toBe(first.getPGliteClient());
  });
});
