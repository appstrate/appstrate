// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Holder for the `PlatformServices` handle injected at `init(ctx)`.
 *
 * EE runs its own database, so it never reads platform-owned tables
 * directly. The platform reads it needs — the append-only `llm_usage` ledger
 * cursor — go through `services.usage.list` / `services.usage.settledFrontier`.
 *
 * Also holds the platform's public base URL (`ctx.appUrl`). Both are captured
 * once at `init(ctx)` and read from here rather than from `index.ts`, so the
 * webhook and sweep paths reach them without importing the module entrypoint
 * that imports them.
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

let _appUrl: string | null = null;

export function setAppUrl(appUrl: string): void {
  _appUrl = appUrl;
}

/** The platform's public base URL — no trailing slash, as `ctx.appUrl` gives it. */
export function getAppUrl(): string {
  if (!_appUrl) throw new Error("EE not initialized. Call init() first.");
  return _appUrl;
}
