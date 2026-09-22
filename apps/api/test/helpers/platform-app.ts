// SPDX-License-Identifier: Apache-2.0

import { setPlatformApp } from "../../src/lib/platform-app.ts";
import { resetCatalog } from "../../src/modules/mcp/catalog.ts";
import { getTestApp } from "./app.ts";

/**
 * Register the SHARED test app as the platform app, for anything that reads the
 * mounted route table. `setPlatformApp` is module-level state in a one-process
 * runner, so a stand-in app registered here would answer for every file loaded
 * after this one.
 */
export function registerTestPlatformApp(): void {
  setPlatformApp(getTestApp());
  // The catalog is derived from the registered app and the module registry, both
  // mutated by other test files in the same process, so a cached one would answer
  // for a state that no longer exists.
  resetCatalog();
}
