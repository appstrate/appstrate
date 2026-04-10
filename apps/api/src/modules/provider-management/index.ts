// SPDX-License-Identifier: Apache-2.0

/**
 * Provider Management module — Org-level LLM model & provider key management.
 *
 * When loaded, registers model CRUD and provider key CRUD routes.
 * Provides the `resolveModel` hook used by the run pipeline to resolve
 * which LLM model to use (org-level + system fallback cascade).
 *
 * Without this module, only system models (from SYSTEM_PROVIDER_KEYS env) are available.
 */

import { resolve } from "node:path";
import { z } from "zod";
import { Hono } from "hono";
import type { AppstrateModule, ModuleInitContext } from "@appstrate/core/module";
import type { AppEnv } from "../../types/index.ts";
import {
  createModelsRouter,
  createModelSchema,
  updateModelSchema,
  setDefaultSchema as modelsSetDefaultSchema,
  testInlineSchema as modelsTestInlineSchema,
} from "./routes/models.ts";
import {
  createProviderKeysRouter,
  createSchema as createProviderKeySchema,
  updateSchema as updateProviderKeySchema,
  testInlineSchema as providerKeysTestInlineSchema,
} from "./routes/provider-keys.ts";
import { resolveModel } from "./services/org-models.ts";
import { modelsPaths } from "./openapi/models.ts";
import { providerKeysPaths } from "./openapi/provider-keys.ts";
import { providerManagementSchemas } from "./openapi/schemas.ts";

const providerManagementModule: AppstrateModule = {
  manifest: { id: "provider-management", name: "Provider Management", version: "1.0.0" },

  async init(ctx: ModuleInitContext) {
    await ctx.applyMigrations(
      "provider-management",
      resolve(import.meta.dir, "drizzle/migrations"),
    );
  },

  createRouter() {
    const router = new Hono<AppEnv>();
    router.route("/models", createModelsRouter());
    router.route("/provider-keys", createProviderKeysRouter());
    return router;
  },

  openApiPaths() {
    return { ...modelsPaths, ...providerKeysPaths };
  },

  openApiComponentSchemas() {
    return providerManagementSchemas;
  },

  openApiSchemas() {
    return [
      {
        method: "POST",
        path: "/api/models",
        jsonSchema: z.toJSONSchema(createModelSchema) as Record<string, unknown>,
        description: "Create model",
      },
      {
        method: "PUT",
        path: "/api/models/{id}",
        jsonSchema: z.toJSONSchema(updateModelSchema) as Record<string, unknown>,
        description: "Update model",
      },
      {
        method: "PUT",
        path: "/api/models/default",
        jsonSchema: z.toJSONSchema(modelsSetDefaultSchema) as Record<string, unknown>,
        description: "Set default model",
      },
      {
        method: "POST",
        path: "/api/models/test",
        jsonSchema: z.toJSONSchema(modelsTestInlineSchema) as Record<string, unknown>,
        description: "Test model config inline",
      },
      {
        method: "POST",
        path: "/api/provider-keys",
        jsonSchema: z.toJSONSchema(createProviderKeySchema) as Record<string, unknown>,
        description: "Create provider key",
      },
      {
        method: "PUT",
        path: "/api/provider-keys/{id}",
        jsonSchema: z.toJSONSchema(updateProviderKeySchema) as Record<string, unknown>,
        description: "Update provider key",
      },
      {
        method: "POST",
        path: "/api/provider-keys/test",
        jsonSchema: z.toJSONSchema(providerKeysTestInlineSchema) as Record<string, unknown>,
        description: "Test provider key inline",
      },
    ];
  },

  features: { models: true, providerKeys: true },

  hooks: {
    resolveModel: async (orgId: string, packageId: string, modelId?: string | null) => {
      return resolveModel(orgId, packageId, modelId ?? null);
    },
  },

  permissions: {
    owner: [
      "models:read",
      "models:write",
      "models:delete",
      "provider-keys:read",
      "provider-keys:write",
      "provider-keys:delete",
    ],
    admin: [
      "models:read",
      "models:write",
      "models:delete",
      "provider-keys:read",
      "provider-keys:write",
      "provider-keys:delete",
    ],
    member: ["models:read"],
    viewer: ["models:read"],
  },
};

export default providerManagementModule;
