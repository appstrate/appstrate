// SPDX-License-Identifier: Apache-2.0

/**
 * Storage module — the platform's storage capability: disks and objects.
 *
 * Scope of this module:
 *   - `storage_disks` / `storage_objects` persistence (tables live in the
 *     core schema per the "modules own no tables" rule — this module only
 *     reads and writes them).
 *   - REST surface under `/api/storage/*` (disk CRUD + cloud sync, object
 *     upload/download/delete + inventory). Auto-exposed over MCP through the
 *     `mcp` module's `invoke_operation`.
 *   - Embeddable React UI exported from `@appstrate/module-storage/ui`.
 *
 * A disk is a backend operated through a `StorageDriver` (drivers/): a NATIVE
 * default disk (the platform S3/FS via `@appstrate/db/storage`, upload/
 * download/delete) plus connected CLOUD disks (S3 buckets, Google Drive —
 * credentials encrypted on the disk row). No worker: cloud sync runs
 * synchronously on demand.
 *
 * storage is the SOURCE OF TRUTH for the object ACL. It already poses the
 * storage→search event contract (a stable opaque object id + a local emission
 * seam — see events.ts) so `module-search` can plug in later with no retrofit.
 */

import type { AppstrateModule, ModuleInitContext } from "@appstrate/core/module";
import { createStorageRouter, createDiskSchema } from "./routes.ts";
import { setCredentialProxy } from "./service.ts";
import { storagePaths, storageComponentSchemas } from "./openapi.ts";
import { z } from "zod";

declare module "@appstrate/core/permissions" {
  interface ModuleResources {
    // read = list/get/download · write = upload objects · delete = delete
    // objects · manage = connect/sync/delete DISKS (they hold org credentials).
    storage: "read" | "write" | "delete" | "manage";
  }
}

const storageModule: AppstrateModule = {
  manifest: { id: "storage", name: "Storage", version: "0.1.0" },

  async init(ctx: ModuleInitContext) {
    // Tables are centralized in the core schema — nothing to migrate. No
    // workers: cloud sync is request-driven (synchronous).
    //
    // Capture the platform credential-proxy: cloud Drive disks reach the Drive
    // API through it, reusing the user's existing integration connection (no
    // module-side OAuth). The native + S3 disks don't need it.
    setCredentialProxy(ctx.services.credentialProxy.call);
    //
    // Per-route rate limiting is wired through `setRateLimitFactory` (routes.ts)
    // — left UNWIRED here because the core `PlatformServices` does not expose a
    // limiter on its own yet (lands with the chat/documents track). The seam
    // degrades gracefully (routes run unlimited).
  },

  createRouter() {
    return createStorageRouter();
  },

  openApiPaths() {
    return storagePaths;
  },

  openApiComponentSchemas() {
    return storageComponentSchemas;
  },

  openApiTags() {
    return [{ name: "Storage", description: "Storage disks and objects" }];
  },

  openApiSchemas() {
    return [
      {
        method: "POST",
        path: "/api/storage/disks",
        jsonSchema: z.toJSONSchema(createDiskSchema) as Record<string, unknown>,
        description: "Connect a cloud disk",
      },
    ];
  },

  features: { storage: true },

  // Reading the inventory and downloading is for every member; uploading
  // (`write`) too — upload is a base storage function. Deleting objects and
  // MANAGING disks (which hold org connection credentials) stay admin-tier.
  // `apiKeyGrantable` on read lets headless deployments read objects;
  // `endUserGrantable` stays false until per-end-user ACL ships.
  permissionsContribution: () => [
    {
      resource: "storage",
      actions: ["read"],
      grantTo: ["owner", "admin", "member", "viewer"],
      apiKeyGrantable: true,
    },
    {
      resource: "storage",
      actions: ["write"],
      grantTo: ["owner", "admin", "member"],
    },
    {
      resource: "storage",
      actions: ["delete", "manage"],
      grantTo: ["owner", "admin"],
    },
  ],
};

export default storageModule;
