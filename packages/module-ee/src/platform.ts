// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Holder for the `PlatformServices` handle injected at `init(ctx)`.
 *
 * EE runs its own database, so it never reads platform-owned tables
 * directly. The platform reads it needs — the append-only `llm_usage` ledger
 * cursor — go through `services.usage.list` / `services.usage.settledFrontier`.
 * Captured once at boot, mirroring the `_appUrl` holder.
 */

import type { PlatformServices } from "@appstrate/core/module";

let _services: PlatformServices | null = null;

export function setPlatformServices(services: PlatformServices): void {
  _services = services;
}

export function getPlatformServices(): PlatformServices {
  if (!_services) throw new Error("EE not initialized. Call init() first.");
  return _services;
}
