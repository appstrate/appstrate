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

import type { Hono } from "hono";
import type { AppstrateModule } from "@appstrate/core/module";
import type { AppEnv } from "../../types/index.ts";
import { createModelsRouter } from "./routes/models.ts";
import { createProviderKeysRouter } from "./routes/provider-keys.ts";
import { resolveModel } from "./services/org-models.ts";

const providerManagementModule: AppstrateModule = {
  manifest: { id: "provider-management", name: "Provider Management", version: "1.0.0" },

  async init() {
    // No-op — DB tables always exist (part of main schema).
    // System model registry is initialized in boot.ts (core responsibility).
  },

  registerRoutes(app) {
    (app as Hono<AppEnv>).route("/api/models", createModelsRouter());
    (app as Hono<AppEnv>).route("/api/provider-keys", createProviderKeysRouter());
  },

  extendAppConfig(base) {
    const features = base.features as Record<string, boolean> | undefined;
    return { ...base, features: { ...features, models: true, providerKeys: true } };
  },

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
