// SPDX-License-Identifier: Apache-2.0

/**
 * Shared registry of built-in modules available during tests.
 *
 * Populated at preload time by the root test preload, which auto-discovers
 * every directory under apps/api/src/modules/* and dynamic-imports its
 * default-exported AppstrateModule. getTestApp() reads the registry to
 * mount each module's router + extend APP_SCOPED_PREFIXES.
 *
 * Tests never call registerTestModule directly — the preload handles it.
 * Consumers only use getDiscoveredModules().
 */
import type { AppstrateModule } from "@appstrate/core/module";
import { validateNoDuplicatePrefixes } from "../../src/lib/modules/module-loader.ts";

const discovered: AppstrateModule[] = [];

export function registerTestModule(mod: AppstrateModule): void {
  if (discovered.includes(mod)) return;
  discovered.push(mod);
  // Fail fast on duplicate route prefixes — mirrors the prod guard in
  // loadModules(). Without this a second module with the same prefix would
  // become silently inert under Hono's first-match-wins routing.
  validateNoDuplicatePrefixes(discovered);
}

export function getDiscoveredModules(): readonly AppstrateModule[] {
  return discovered;
}
