// SPDX-License-Identifier: Apache-2.0

// Loader
export {
  loadModules,
  loadModulesFromInstances,
  registerBuiltinModule,
  getModule,
  getModules,
  getModulePublicPaths,
  registerModuleRoutes,
  applyModuleAppConfig,
  callHook,
  hasHook,
  emitEvent,
  shutdownModules,
  resetModules,
} from "./module-loader.ts";

// Hooks
export {
  beforeSignup,
  beforeRun,
  afterRun,
  onOrgCreated,
  onOrgDeleted,
  type RunRejection,
} from "./hooks.ts";

// Registry
export { getModuleRegistry, buildModuleInitContext } from "./registry.ts";
