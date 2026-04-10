// SPDX-License-Identifier: Apache-2.0

/**
 * Webhooks module — Standard Webhooks event delivery for agent runs.
 *
 * When loaded, registers webhook CRUD routes and a BullMQ delivery worker.
 * Listens to `onRunStatusChange` events emitted by the core run pipeline
 * and dispatches matching webhooks to subscribers.
 */

import { resolve } from "node:path";
import { z } from "zod";
import type {
  AppstrateModule,
  ModuleInitContext,
  RunStatusChangeParams,
} from "@appstrate/core/module";
import { createWebhooksRouter, createWebhookSchema, updateWebhookSchema } from "./routes.ts";
import { initWebhookWorker, shutdownWebhookWorker, dispatchRunWebhook } from "./service.ts";
import { webhooksPaths } from "./openapi/paths.ts";
import { webhooksSchemas } from "./openapi/schemas.ts";
import { applyModuleMigrations } from "../../lib/modules/migrate.ts";

const webhooksModule: AppstrateModule = {
  manifest: { id: "webhooks", name: "Webhooks", version: "1.0.0" },

  async init(ctx: ModuleInitContext) {
    await applyModuleMigrations(ctx, "webhooks", resolve(import.meta.dir, "drizzle/migrations"));
    initWebhookWorker();
  },

  createRouter() {
    return createWebhooksRouter();
  },

  openApiPaths() {
    return webhooksPaths;
  },

  openApiComponentSchemas() {
    return webhooksSchemas;
  },

  openApiSchemas() {
    return [
      {
        method: "POST",
        path: "/api/webhooks",
        jsonSchema: z.toJSONSchema(createWebhookSchema) as Record<string, unknown>,
        description: "Create webhook",
      },
      {
        method: "PUT",
        path: "/api/webhooks/{id}",
        jsonSchema: z.toJSONSchema(updateWebhookSchema) as Record<string, unknown>,
        description: "Update webhook",
      },
    ];
  },

  features: { webhooks: true },

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
