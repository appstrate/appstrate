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
  getModuleOpenApiPaths,
  getModuleOpenApiComponentSchemas,
  getModuleOpenApiSchemas,
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
  onRunStatusChange,
  onOrgCreate,
  onOrgDelete,
  type RunRejection,
  type RunStatusChangeParams,
} from "./hooks.ts";

// Registry
export { getModuleRegistry, buildModuleInitContext } from "./registry.ts";
