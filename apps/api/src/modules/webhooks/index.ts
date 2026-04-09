// SPDX-License-Identifier: Apache-2.0

/**
 * Webhooks module — Standard Webhooks event delivery for agent runs.
 *
 * When loaded, registers webhook CRUD routes and a BullMQ delivery worker.
 * Listens to "run:statusChanged" events emitted by the core run pipeline
 * and dispatches matching webhooks to subscribers.
 */

import type { Hono } from "hono";
import type { AppstrateModule, RunStatusChangedParams } from "@appstrate/core/module";
import type { AppEnv } from "../../types/index.ts";
import { createWebhooksRouter } from "./routes.ts";
import { initWebhookWorker, shutdownWebhookWorker, dispatchRunWebhook } from "./service.ts";

const webhooksModule: AppstrateModule = {
  manifest: { id: "webhooks", name: "Webhooks", version: "1.0.0" },

  async init() {
    initWebhookWorker();
  },

  registerRoutes(app) {
    (app as Hono<AppEnv>).route("/api", createWebhooksRouter());
  },

  extendAppConfig(base) {
    const features = base.features as Record<string, boolean> | undefined;
    return { ...base, features: { ...features, webhooks: true } };
  },

  permissions: {
    owner: ["webhooks:read", "webhooks:write", "webhooks:delete"],
    admin: ["webhooks:read", "webhooks:write", "webhooks:delete"],
  },

  events: {
    "run:statusChanged": async (payload: RunStatusChangedParams) => {
      dispatchRunWebhook(
        payload.orgId,
        payload.applicationId,
        payload.status,
        payload.runId,
        payload.packageId,
        payload.extra,
      );
    },
  },

  async shutdown() {
    await shutdownWebhookWorker();
  },
};

export default webhooksModule;
