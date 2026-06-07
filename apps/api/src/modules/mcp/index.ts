// SPDX-License-Identifier: Apache-2.0

/**
 * MCP module — exposes the platform REST API as an inbound MCP server.
 *
 * Mounts `/mcp` (Streamable HTTP) plus RFC 9728 discovery. The ~250 platform
 * operations are surfaced through three progressive-disclosure tools
 * (`search_operations`, `describe_operation`, `invoke_operation`) rather than
 * one tool per endpoint, keeping the client tool budget tiny. Tool calls
 * dispatch in-process through the platform app, reusing the auth pipeline and
 * RBAC — an MCP caller can do exactly what the same credential can do over REST.
 *
 * Consumers: external MCP clients (Claude Desktop, Cursor) via OAuth, the
 * first-party chat app (BFF reuses its OIDC token), and Appstrate agents.
 */

import type { AppstrateModule } from "@appstrate/core/module";
import { createMcpRouter } from "./router.ts";
import { mcpPaths } from "./openapi/paths.ts";

// Register `mcp` as a module-owned RBAC resource. Declaration merging on
// `ModuleResources` re-enters the typed Resource union consumed by
// `requirePermission` / `requireModulePermission`, so the guards stay narrowed.
declare module "@appstrate/core/permissions" {
  interface ModuleResources {
    mcp: "read" | "invoke";
  }
}

const mcpModule: AppstrateModule = {
  manifest: { id: "mcp", name: "MCP Server", version: "1.0.0" },

  // Stateless — nothing to start at boot. The operation catalog is built
  // lazily on first request (after all modules have contributed their paths).
  async init() {},

  createRouter() {
    return createMcpRouter();
  },

  // RFC 9728 metadata is public discovery — no auth. Both the bare well-known
  // and the path-insertion variant (RFC 9728 §3.1) are served.
  publicPaths: [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/api/mcp",
  ],

  openApiPaths() {
    return mcpPaths;
  },

  openApiTags() {
    return [{ name: "MCP", description: "Model Context Protocol server over the platform API" }];
  },

  features: { mcp: true },

  // RBAC contribution. `mcp:read` (search/describe + reach the endpoint) is
  // broad — every role including viewer; `mcp:invoke` (execute an operation)
  // excludes viewer. Both are API-key- and end-user-grantable: headless agents
  // and embedding apps are first-class consumers. Defence in depth — the
  // dispatched operation still enforces its own permission, so `mcp:invoke`
  // can never exceed the caller's other grants.
  permissionsContribution: () => [
    {
      resource: "mcp",
      actions: ["read"],
      grantTo: ["owner", "admin", "member", "viewer"],
      apiKeyGrantable: true,
      endUserGrantable: true,
    },
    {
      resource: "mcp",
      actions: ["invoke"],
      grantTo: ["owner", "admin", "member"],
      apiKeyGrantable: true,
      endUserGrantable: true,
    },
  ],
};

export default mcpModule;
