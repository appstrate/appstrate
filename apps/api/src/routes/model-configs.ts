// SPDX-License-Identifier: Apache-2.0

import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { listResponse } from "@appstrate/core/list-query";
import { readJsonBody } from "@appstrate/core/request-body";
import { requirePermission } from "../middleware/require-permission.ts";
import { endpointUrlSchema } from "../lib/endpoint-url.ts";
import { internalError } from "../lib/errors.ts";
import { recordAuditFromContext } from "../services/audit.ts";
import { clearModelPointers } from "../services/org-models.ts";
import {
  createModelConfig,
  deleteModelConfig,
  getModelConfigInfo,
  listModelConfigs,
  updateModelConfig,
} from "../services/model-configs.ts";

export const createModelConfigSchema = z
  .object({
    provider_id: z.string().min(1, "provider_id is required"),
    label: z.string().trim().min(1).max(120).optional(),
    /** Required for a gateway provider (its endpoint), refused for any other. */
    base_url: endpointUrlSchema.optional(),
    personal_connections_allowed: z.boolean().optional(),
  })
  .strict();

export const updateModelConfigSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    /** A gateway's endpoint; refused for any other provider. Cannot move while the configuration has connections. */
    base_url: endpointUrlSchema.optional(),
    personal_connections_allowed: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "Set at least one of label, base_url, personal_connections_allowed",
  });

/** Whether the caller reads the organization's connections (who holds a personal one). */
function readsCredentials(c: Context<AppEnv>): boolean {
  return c.get("permissions")?.has("model-provider-credentials:read") ?? false;
}

async function configResponse(c: Context<AppEnv>, id: string) {
  const config = await getModelConfigInfo(c.get("orgId"), id, {
    readsCredentials: readsCredentials(c),
  });
  if (!config) throw internalError();
  return config;
}

export function createModelConfigsRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/model-configs — every configuration of the organization
  router.get("/", requirePermission("models", "read"), async (c) => {
    const configs = await listModelConfigs(c.get("orgId"), {
      readsCredentials: readsCredentials(c),
    });
    return c.json(listResponse(configs));
  });

  // POST /api/model-configs — create a configuration
  router.post("/", requirePermission("models", "write"), async (c) => {
    const data = await readJsonBody(c, createModelConfigSchema);
    const id = await createModelConfig(c.get("orgId"), c.get("user").id, {
      providerId: data.provider_id,
      label: data.label,
      baseUrl: data.base_url,
      personalConnectionsAllowed: data.personal_connections_allowed,
    });
    const config = await configResponse(c, id);
    await recordAuditFromContext(c, {
      action: "model_config.created",
      resourceType: "model_config",
      resourceId: id,
      after: {
        providerId: config.provider_id,
        label: config.label,
        baseUrl: config.base_url,
        personalConnectionsAllowed: config.personal_connections_allowed,
      },
    });
    return c.json(config, 201);
  });

  // PATCH /api/model-configs/:id — rename, move a gateway's endpoint, switch personal connections
  router.patch("/:id", requirePermission("models", "write"), async (c) => {
    const id = c.req.param("id")!;
    const data = await readJsonBody(c, updateModelConfigSchema);
    await updateModelConfig(c.get("orgId"), id, {
      label: data.label,
      baseUrl: data.base_url,
      personalConnectionsAllowed: data.personal_connections_allowed,
    });
    await recordAuditFromContext(c, {
      action: "model_config.updated",
      resourceType: "model_config",
      resourceId: id,
      after: {
        ...(data.label !== undefined ? { label: data.label } : {}),
        ...(data.base_url !== undefined ? { baseUrl: data.base_url } : {}),
        ...(data.personal_connections_allowed !== undefined
          ? { personalConnectionsAllowed: data.personal_connections_allowed }
          : {}),
      },
    });
    return c.json(await configResponse(c, id));
  });

  // DELETE /api/model-configs/:id — delete it with its connections and models. It removes
  // connections and models, so it takes both delete permissions and audits each removal.
  router.delete(
    "/:id",
    requirePermission("models", "delete"),
    requirePermission("model-provider-credentials", "delete"),
    async (c) => {
      const id = c.req.param("id")!;
      const orgId = c.get("orgId");
      const removed = await deleteModelConfig(orgId, id);
      await clearModelPointers(
        orgId,
        removed.models.map((m) => m.id),
      );
      for (const connection of removed.connections) {
        await recordAuditFromContext(c, {
          action: "model_provider_credential.deleted",
          resourceType: "model_provider_credential",
          resourceId: connection.id,
          before: {
            ownerType: connection.ownerUserId === null ? "org" : "user",
            ownerId: connection.ownerUserId,
            providerId: connection.providerId,
            label: connection.label,
            configId: id,
            ...(connection.ownerUserId !== null && connection.ownerUserId !== c.get("user").id
              ? { breakGlass: true }
              : {}),
          },
        });
      }
      for (const model of removed.models) {
        await recordAuditFromContext(c, {
          action: "model.deleted",
          resourceType: "model",
          resourceId: model.id,
          before: { modelId: model.modelId, label: model.label, configId: id },
        });
      }
      await recordAuditFromContext(c, {
        action: "model_config.deleted",
        resourceType: "model_config",
        resourceId: id,
        before: { providerId: removed.config.providerId, label: removed.config.label },
      });
      return c.body(null, 204);
    },
  );

  return router;
}
