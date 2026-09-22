// SPDX-License-Identifier: Apache-2.0

/**
 * Shared registry of built-in modules available during tests.
 *
 * Populated at preload time by the root test preload, which auto-discovers
 * every directory under apps/api/src/modules/* and dynamic-imports its
 * default-exported AppstrateModule. getTestApp() reads the registry to
 * mount each module's router.
 *
 * Tests never call registerTestModule directly — the preload handles it.
 * Consumers only use getDiscoveredModules().
 */
import type { AppstrateModule } from "@appstrate/core/module";
import { loadModulesFromInstances, resetModules } from "../../src/lib/modules/module-loader.ts";
import { buildModuleInitContext } from "../../src/lib/modules/registry.ts";

const discovered: AppstrateModule[] = [];

export function registerTestModule(mod: AppstrateModule): void {
  if (discovered.includes(mod)) return;
  discovered.push(mod);
}

export function getDiscoveredModules(): readonly AppstrateModule[] {
  return discovered;
}

/**
 * Put the module-loader registry back the way the preload left it.
 *
 * A file that swaps in a fake module owns the registry for its duration, but
 * the state it must return to is the preload's — not an empty map. Anything
 * derived from `_modules` (the module-contributed OpenAPI paths the platform-app
 * registration joins, the RBAC snapshot) reads a registry emptied by a sibling
 * file as a smaller platform, and answers for one.
 */
export async function restoreDiscoveredModules(): Promise<void> {
  resetModules();
  await loadModulesFromInstances([...discovered], buildModuleInitContext());
}
