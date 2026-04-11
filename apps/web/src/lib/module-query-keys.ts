// SPDX-License-Identifier: Apache-2.0
/// <reference types="vite/client" />

/**
 * Module-contributed app-scoped React Query keys.
 *
 * Each file at `apps/web/src/modules/<name>/query-keys.ts` default-exports a
 * readonly string[] of React Query key prefixes owned by that module. Vite's
 * `import.meta.glob` picks them up at build time, keyed by the module
 * directory name — which must match a feature flag on `AppConfig.features`.
 *
 * Zero-footprint invariant: deleting `apps/web/src/modules/<name>/` removes
 * the contribution entirely. Core never names the module.
 */

import type { AppConfig } from "@appstrate/shared-types";

// `eager: true` inlines each contribution at build time — no runtime async
// import, no code splitting — since these are small constant arrays that must
// be synchronously available during `switchApp`.
const contributions = import.meta.glob<{ default: readonly string[] }>(
  "../modules/*/query-keys.ts",
  { eager: true },
);

const MODULE_APP_SCOPED_KEYS: Record<string, readonly string[]> = {};
for (const [path, mod] of Object.entries(contributions)) {
  const match = path.match(/modules\/([^/]+)\/query-keys\.ts$/);
  if (match && mod.default) {
    MODULE_APP_SCOPED_KEYS[match[1]!] = mod.default;
  }
}

export function getEnabledModuleQueryKeys(features: AppConfig["features"]): string[] {
  const keys: string[] = [];
  for (const [flag, moduleKeys] of Object.entries(MODULE_APP_SCOPED_KEYS)) {
    if (features[flag]) keys.push(...moduleKeys);
  }
  return keys;
}
