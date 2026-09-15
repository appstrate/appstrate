// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Tier 0 runs the platform on PGlite and leaves `DATABASE_URL` unset. This
 * module stores its tables in the platform database, so there is nothing for it
 * to open — and the module loader turns an `init` throw into a fatal boot, so
 * naming the variable in the message is the whole of the operator's diagnosis.
 */

import { describe, expect, it } from "bun:test";
import eeModule from "../../src/index.ts";
import { applyEeFixtureEnv } from "../helpers/fixture-env.ts";

applyEeFixtureEnv();

describe("ee init without DATABASE_URL", () => {
  it("refuses with a message naming DATABASE_URL", async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      // The refusal precedes every side effect, so a context that carries none
      // of the platform's handles is enough to reach it.
      await expect(
        eeModule.init!({} as unknown as Parameters<NonNullable<typeof eeModule.init>>[0]),
      ).rejects.toThrow(
        "The ee module requires PostgreSQL: set DATABASE_URL (the module stores its tables in the platform database)",
      );
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });
});
