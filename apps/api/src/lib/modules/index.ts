// SPDX-License-Identifier: Apache-2.0

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
  emitEvent,
  shutdownModules,
  resetModules,
} from "./module-loader.ts";

// Registry
export { getModuleRegistry, buildModuleInitContext } from "./registry.ts";
