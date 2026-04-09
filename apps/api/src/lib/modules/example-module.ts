// SPDX-License-Identifier: Apache-2.0

/**
 * Example module — demonstrates the AppstrateModule contract.
 *
 * To enable: add to the module registry in registry.ts:
 *   import { createExampleModule } from "./example-module.ts";
 *   { module: createExampleModule() }
 */

import { Hono } from "hono";
import type { AppstrateModule, ModuleInitContext } from "./types.ts";
import type { AppEnv } from "../../types/index.ts";
import { logger } from "../logger.ts";

export function createExampleModule(): AppstrateModule {
  return {
    manifest: {
      id: "example",
      name: "Example Module",
      version: "0.1.0",
    },

    async init(_ctx: ModuleInitContext) {
      logger.info("Example module initialized");
    },

    publicPaths: ["/api/example/ping"],

    registerRoutes(app) {
      const router = new Hono<AppEnv>();
      router.get("/example/ping", (c) => c.json({ pong: true }));
      app.route("/api", router);
    },

    extendAppConfig(base) {
      return {
        features: { ...base.features, example: true },
      };
    },

    async shutdown() {
      logger.info("Example module shutdown");
    },
  };
}
