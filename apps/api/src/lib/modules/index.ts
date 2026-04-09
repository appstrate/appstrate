// SPDX-License-Identifier: Apache-2.0

export type { AppstrateModule, ModuleManifest, ModuleInitContext, ModuleEntry } from "./types.ts";
export { SkipModuleError } from "./types.ts";

export {
  loadModules,
  getModule,
  getModules,
  getModulePublicPaths,
  registerModuleRoutes,
  applyModuleAppConfig,
  shutdownModules,
  resetModules,
} from "./module-loader.ts";

export { getModuleRegistry, buildModuleInitContext } from "./registry.ts";
