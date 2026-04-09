// SPDX-License-Identifier: Apache-2.0

/**
 * Webhooks module — Standard Webhooks event delivery for agent runs.
 *
 * When loaded, registers webhook CRUD routes and a BullMQ delivery worker.
 * Listens to `onRunStatusChange` events emitted by the core run pipeline
 * and dispatches matching webhooks to subscribers.
 */

import type { Hono } from "hono";
import type { AppstrateModule, RunStatusChangeParams } from "@appstrate/core/module";
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
    onRunStatusChange: async (params: RunStatusChangeParams) => {
      dispatchRunWebhook(
        params.orgId,
        params.applicationId,
        params.status,
        params.runId,
        params.agentId,
        {
          ...params.extra,
          ...(params.duration != null ? { duration: params.duration } : {}),
        },
      );
    },
  },

  async shutdown() {
    await shutdownWebhookWorker();
  },
};

export default webhooksModule;
