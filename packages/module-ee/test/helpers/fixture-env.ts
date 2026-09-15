// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import requirements from "../requirements.ts";
import { _resetEeEnvForTests } from "../../src/env.ts";

/**
 * Apply the fixture environment this module declares in `test/requirements.ts`.
 *
 * The module declares `postgres: true`, so under `TEST_TIER=0` the preload
 * refuses to load it and never reaches the line that applies `requirements.env`
 * — yet bun still collects a test file named directly on the command line. A
 * pure schema/catalog test needs no database, only those values, so it applies
 * them itself instead of inheriting whatever the developer's `.env` holds.
 *
 * Call it at the top level of such a file, BEFORE the first `getEeEnv()`: the
 * parsed env is a lazy singleton, so this precedes every read while the
 * `src/**` imports above it are already evaluated. Idempotent — tiers 1+ have
 * the preload assign the very same values.
 */
export function applyEeFixtureEnv(): void {
  Object.assign(process.env, requirements.env);
  _resetEeEnvForTests();
}
