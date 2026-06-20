// SPDX-License-Identifier: Apache-2.0

/**
 * Search module — the platform's search capability: index content and answer
 * hybrid queries.
 *
 * Scope of this module:
 *   - `search_items` (registry) / `search_chunks` (the index) persistence
 *     (tables live in the core schema per the "modules own no tables" rule —
 *     this module only reads and writes them).
 *   - the storage→search SEAM: it LISTENS for storage object events
 *     (`onStorageObject{Upserted,Deleted,AclChanged}`) and reacts — index /
 *     evict / re-scope. It reads object bytes by opaque id over the storage
 *     API (loopback), never a JOIN (strategy §5).
 *   - the heavy ingestion (extract → chunk → embed) runs on `services.queues`
 *     so a storage upsert never blocks on indexing.
 *   - REST surface `POST /api/search`. Auto-exposed over MCP through the `mcp`
 *     module's `invoke_operation`.
 *
 * search is CONTENT-AGNOSTIC and owns no files — storage does. It indexes what
 * the seam hands it and answers `search(query, acl)`.
 */

import type { AppstrateModule, ModuleInitContext } from "@appstrate/core/module";
import { createSearchRouter } from "./routes.ts";
import { searchPaths, searchComponentSchemas } from "./openapi.ts";
import { detectSemanticCapability } from "./capability.ts";
import {
  initSearchIngestion,
  shutdownSearchIngestion,
  onObjectUpserted,
  onObjectDeleted,
  onObjectAclChanged,
} from "./service.ts";
import { searchLoopbackStrategy } from "./loopback.ts";

declare module "@appstrate/core/permissions" {
  interface ModuleResources {
    // read = run a query. Indexing is not a user action — it is driven by the
    // storage event seam + the internal loopback read (`storage:read`), so
    // there is no user-facing write permission on the index in v1.
    search: "read";
  }
}

const searchModule: AppstrateModule = {
  manifest: { id: "search", name: "Search", version: "0.1.0", dependencies: ["storage"] },

  async init(ctx: ModuleInitContext) {
    // Tables are centralized in the core schema — nothing to migrate. Probe the
    // pgvector capability once (semantic vs keyword-only), then start the
    // ingestion worker (queue create + process handler).
    await detectSemanticCapability(ctx.services.logger);
    await initSearchIngestion(ctx);
  },

  async shutdown() {
    await shutdownSearchIngestion();
  },

  createRouter() {
    return createSearchRouter();
  },

  // The storage→search seam: storage emits, search reacts. Broadcast handlers,
  // side-effect only; the platform isolates errors per handler.
  events: {
    onStorageObjectUpserted: onObjectUpserted,
    onStorageObjectDeleted: onObjectDeleted,
    onStorageObjectAclChanged: onObjectAclChanged,
  },

  // The ingestion read identity: a process-local bearer scoped to `storage:read`
  // so search can read object bytes by id over the storage API (see loopback.ts).
  authStrategies() {
    return [searchLoopbackStrategy];
  },

  openApiPaths() {
    return searchPaths;
  },

  openApiComponentSchemas() {
    return searchComponentSchemas;
  },

  openApiTags() {
    return [{ name: "Search", description: "Index queries (hybrid retrieval)" }];
  },

  features: { search: true },

  // Reading (querying) is for every member; `apiKeyGrantable` lets headless
  // deployments and agents (via MCP) search. No write/manage tier — the index
  // is populated by the event seam, not by direct user writes.
  permissionsContribution: () => [
    {
      resource: "search",
      actions: ["read"],
      grantTo: ["owner", "admin", "member", "viewer"],
      apiKeyGrantable: true,
    },
  ],
};

export default searchModule;
