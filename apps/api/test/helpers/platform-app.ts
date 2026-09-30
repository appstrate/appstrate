// SPDX-License-Identifier: Apache-2.0

import { registerPlatformApp } from "../../src/lib/platform-app.ts";
import { getModules } from "../../src/lib/modules/module-loader.ts";
import { getTestApp } from "./app.ts";
import { getDiscoveredModules, restoreDiscoveredModules } from "./test-modules.ts";

/**
 * Register the SHARED test app through production's registration, so the
 * spec/route join and its refusal run here too. Registration is module-level
 * state in a one-process runner, so a stand-in app registered here would
 * answer for every file loaded after this one.
 *
 * The spec half of the join comes from the module registry, which a sibling
 * file may have left different from what the shared app mounts — module
 * operations would then be missing, or unserved. So it is restored first
 * whenever it differs from what the preload discovered.
 */
export async function registerTestPlatformApp(): Promise<void> {
  const loaded = getModules();
  const discovered = getDiscoveredModules();
  if (loaded.size !== discovered.length || discovered.some((mod) => !loaded.has(mod.manifest.id))) {
    await restoreDiscoveredModules();
  }
  registerPlatformApp(getTestApp());
}
