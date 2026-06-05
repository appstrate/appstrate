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

const discovered: AppstrateModule[] = [];

export function registerTestModule(mod: AppstrateModule): void {
  if (discovered.includes(mod)) return;
  discovered.push(mod);
}

export function getDiscoveredModules(): readonly AppstrateModule[] {
  return discovered;
}
