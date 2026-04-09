// SPDX-License-Identifier: Apache-2.0

// Core types (re-exported from @appstrate/core/module)
export type { AppstrateModule, ModuleManifest, ModuleInitContext, ModuleEntry } from "./types.ts";
export { SkipModuleError } from "./types.ts";

// Loader
export {
  loadModules,
  loadModulesFromInstances,
  getModule,
  getModules,
  getModulePublicPaths,
  registerModuleRoutes,
  applyModuleAppConfig,
  callHook,
  getHookValue,
  hasHook,
  shutdownModules,
  resetModules,
} from "./module-loader.ts";

// Registry
export { getModuleRegistry, buildModuleInitContext } from "./registry.ts";
