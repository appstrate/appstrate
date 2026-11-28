// SPDX-License-Identifier: Apache-2.0

import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { listResponse } from "@appstrate/core/list-query";
import { readJsonBody } from "@appstrate/core/request-body";
import { requirePermission } from "../middleware/require-permission.ts";
import { internalError, notFound } from "../lib/errors.ts";
import { recordAuditFromContext } from "../services/audit.ts";
import {
  createModelConfig,
  deleteModelConfig,
  getModelConfigInfo,
  listModelConfigs,
  updateModelConfig,
} from "../services/model-configs.ts";

/** Not `z.httpUrl()`: that one refuses the IP or `localhost` of a self-hosted endpoint. */
const endpointUrlSchema = z.url({ protocol: /^https?$/ });

export const createModelConfigSchema = z
  .object({
    provider_id: z.string().min(1, "provider_id is required"),
    label: z.string().min(1).max(120).optional(),
    /** Required for a gateway provider (its endpoint), refused for any other. */
    base_url: endpointUrlSchema.optional(),
    personal_connections_allowed: z.boolean().optional(),
  })
  .strict();

export const updateModelConfigSchema = z
  .object({
    label: z.string().min(1).max(120).optional(),
    /** A gateway's endpoint; refused for any other provider. */
    base_url: endpointUrlSchema.optional(),
    personal_connections_allowed: z.boolean().optional(),
  })
  .strict();

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

  // DELETE /api/model-configs/:id — delete it with its connections and models
  router.delete("/:id", requirePermission("models", "delete"), async (c) => {
    const id = c.req.param("id")!;
    const orgId = c.get("orgId");
    const before = await getModelConfigInfo(orgId, id, { readsCredentials: false });
    if (!before) throw notFound("Model configuration not found");
    await deleteModelConfig(orgId, id);
    await recordAuditFromContext(c, {
      action: "model_config.deleted",
      resourceType: "model_config",
      resourceId: id,
      before: { providerId: before.provider_id, label: before.label },
    });
    return c.body(null, 204);
  });

  return router;
}
