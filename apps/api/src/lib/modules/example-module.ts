// SPDX-License-Identifier: Apache-2.0

/**
 * Example module — demonstrates the AppstrateModule contract.
 *
 * To enable: add to the APPSTRATE_MODULES env var:
 *   APPSTRATE_MODULES=./src/lib/modules/example-module.ts
 *
 * In a real external module (like @appstrate/cloud), the module would
 * import types from `@appstrate/core/module` (published on npm) and
 * export a default AppstrateModule.
 */

import { Hono } from "hono";
import type { AppstrateModule, ModuleInitContext } from "@appstrate/core/module";
import type { AppEnv } from "../../types/index.ts";
import { logger } from "../logger.ts";

const exampleModule: AppstrateModule = {
  manifest: {
    id: "example",
    name: "Example Module",
    version: "0.1.0",
  },

  async init(_ctx: ModuleInitContext) {
    logger.info("Example module initialized");
  },

  publicPaths: ["/api/example/ping"],

  createRouter() {
    const router = new Hono<AppEnv>();
    router.get("/example/ping", (c) => c.json({ pong: true }));
    return router;
  },

  extendAppConfig() {
    return { features: { example: true } };
  },

  async shutdown() {
    logger.info("Example module shutdown");
  },
};

export default exampleModule;
