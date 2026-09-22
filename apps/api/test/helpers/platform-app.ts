// SPDX-License-Identifier: Apache-2.0

import { setPlatformApp } from "../../src/lib/platform-app.ts";
import { getModules } from "../../src/lib/modules/module-loader.ts";
import { resetCatalog } from "../../src/modules/mcp/catalog.ts";
import { getTestApp } from "./app.ts";
import { getDiscoveredModules, restoreDiscoveredModules } from "./test-modules.ts";

/**
 * Register the SHARED test app as the platform app, for anything that reads the
 * mounted route table. `setPlatformApp` is module-level state in a one-process
 * runner, so a stand-in app registered here would answer for every file loaded
 * after this one.
 *
 * The route table is only half of what the MCP catalog joins: the other half is
 * the module registry, and a sibling file that emptied it leaves the modules'
 * OpenAPI paths out of the spec — operations silently absent rather than
 * unjoined. So the registry is repaired first when it is short of a module the
 * preload discovered.
 */
export async function registerTestPlatformApp(): Promise<void> {
  const loaded = getModules();
  if (getDiscoveredModules().some((mod) => !loaded.has(mod.manifest.id))) {
    await restoreDiscoveredModules();
  }
  setPlatformApp(getTestApp());
  // The catalog is derived from the registered app and the module registry, both
  // mutated by other test files in the same process, so a cached one would answer
  // for a state that no longer exists.
  resetCatalog();
}
