// SPDX-License-Identifier: Apache-2.0

/**
 * Webhooks module — Standard Webhooks event delivery for agent runs.
 *
 * When loaded, registers webhook CRUD routes and a BullMQ delivery worker.
 * Listens to `onRunStatusChange` events emitted by the core run pipeline
 * and dispatches matching webhooks to subscribers.
 */

import { z } from "zod";
import type {
  AppstrateModule,
  RunConnectionMissingParams,
  RunStatusChangeParams,
} from "@appstrate/core/module";
import {
  createWebhooksRouter,
  createWebhookSchema,
  updateWebhookSchema,
  rotateSecretSchema,
} from "./routes.ts";
import {
  dispatchRunConnectionMissingWebhook,
  dispatchRunWebhook,
  initWebhookWorker,
  shutdownWebhookWorker,
} from "./service.ts";
import { webhooksPaths } from "./openapi/paths.ts";
import { webhooksSchemas } from "./openapi/schemas.ts";

// Register the two webhook RBAC resources. A webhook is scoped at either
// level (`level: "org" | "space"`), and the two halves are not the same
// grant: an org-level webhook fires for every space, so it belongs to the
// org roles, while a space-pinned one belongs to the space's own roles.
// One resource for both would make "may administer this space's webhooks"
// indistinguishable from "may fan out across every space in the org".
//
// The declaration merging on `ModuleResources` re-enters the typed Resource
// union consumed by `apps/api/src/middleware/require-permission.ts` and
// by the standalone `requireModulePermission` helper in core, so
// `requirePermission("webhooks", "write")` and
// `requireModulePermission("org-webhooks", "write")` stay fully narrowed.
declare module "@appstrate/core/permissions" {
  interface ModuleResources {
    webhooks: "read" | "write" | "delete";
    "org-webhooks": "read" | "write" | "delete";
  }
}

const webhooksModule: AppstrateModule = {
  manifest: { id: "webhooks", name: "Webhooks", version: "1.0.0" },

  async init() {
    // Tables (`webhooks`, `webhook_deliveries`) are centralized in the core
    // schema and created by the system migration pipeline — no module migration.
    await initWebhookWorker();
  },

  createRouter() {
    return createWebhooksRouter();
  },

  // Webhooks are org-scoped routes. The request body (level: "org" |
  // "space") determines the scope of the individual webhook resource;
  // the surrounding route no longer requires X-Space-Id.

  openApiPaths() {
    return webhooksPaths;
  },

  openApiComponentSchemas() {
    return webhooksSchemas;
  },

  openApiTags() {
    return [{ name: "Webhooks", description: "Webhook configuration and delivery" }];
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
      {
        method: "POST",
        path: "/api/webhooks/{id}/rotate",
        jsonSchema: z.toJSONSchema(rotateSecretSchema) as Record<string, unknown>,
        description: "Rotate webhook signing secret",
      },
    ];
  },

  features: { webhooks: true },

  // RBAC contribution: webhooks stay admin-tier at both levels. Webhook
  // secrets and delivery data are sensitive (org integrations, downstream
  // systems), so the space half reaches the `admin` and `builder` presets
  // only — `operator`/`viewer` get nothing, matching the org-role matrix this
  // replaced. Only the SPACE half is API-key-grantable: a key always resolves
  // to a `SpaceScope`, so it can never reach an org-level row and an
  // `org-webhooks` scope on a key would grant nothing it could use. End-user
  // OIDC tokens are denied at both levels (`endUserGrantable` stays false) —
  // embedding apps do not administer the org's outbound integrations.
  permissionsContribution: () => [
    {
      resource: "webhooks",
      actions: ["read", "write", "delete"],
      level: "space",
      presets: ["admin", "builder"],
      apiKeyGrantable: true,
    },
    {
      resource: "org-webhooks",
      actions: ["read", "write", "delete"],
      level: "org",
      grantTo: ["owner", "admin"],
    },
  ],

  events: {
    onRunStatusChange: (params: RunStatusChangeParams) => {
      dispatchRunWebhook(
        { orgId: params.orgId, spaceId: params.spaceId },
        params.status,
        params.runId,
        params.packageId,
        {
          ...params.extra,
          ...(params.duration != null ? { duration: params.duration } : {}),
          // Surface the inline flag so downstream consumers can branch
          // without an extra DB round-trip. Absent in classic runs —
          // receivers treat missing as `false`.
          ...(params.packageEphemeral ? { package: { ephemeral: true } } : {}),
        },
      );
    },
    onRunConnectionMissing: (params: RunConnectionMissingParams) => {
      dispatchRunConnectionMissingWebhook(
        { orgId: params.orgId, spaceId: params.spaceId },
        params.packageId,
        params.actor,
        params.errors,
      );
    },
  },

  async shutdown() {
    await shutdownWebhookWorker();
  },
};

export default webhooksModule;
