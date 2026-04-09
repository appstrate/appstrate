// SPDX-License-Identifier: Apache-2.0

/**
 * Re-export core module types + platform-specific extensions.
 *
 * Core types (`@appstrate/core/module`) are framework-agnostic and published
 * on npm so external modules can implement them. This file adds Hono-specific
 * convenience types used only within the API package.
 */

// Re-export everything from core
export type {
  AppstrateModule,
  ModuleManifest,
  ModuleInitContext,
  ModuleEntry,
} from "@appstrate/core/module";
export { SkipModuleError } from "@appstrate/core/module";
