// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS 2.0 mcp-server manifest — re-exported from `@afps-spec/schema`.
 *
 * An `mcp-server` package's `manifest.json` IS a verbatim MCP Bundle (MCPB)
 * manifest plus the AFPS identity contract under `_meta["dev.afps/mcp-server"]`
 * (AFPS §3.4). Appstrate adds no extensions on top of the canonical schema —
 * this module simply surfaces the schema/type at a stable `@appstrate/core`
 * subpath so the platform validates mcp-server manifests against the spec.
 */

import {
  mcpServerManifestSchema,
  mcpServerTypeEnum,
  mcpServerAfpsMeta,
  type McpServerManifest,
} from "@afps-spec/schema";

export { mcpServerManifestSchema, mcpServerTypeEnum, mcpServerAfpsMeta };
export type { McpServerManifest };

/** The `_meta` key carrying an mcp-server's portable AFPS identity (§3.4). */
export const MCP_SERVER_META_KEY = "dev.afps/mcp-server";

/**
 * Read an mcp-server's AFPS package identity from
 * `_meta["dev.afps/mcp-server"].name` (the top-level `name` is MCPB-governed,
 * not the AFPS scoped identity — §3.4 / §2.2).
 */
export function getMcpServerAfpsName(manifest: McpServerManifest): string | undefined {
  const meta = (manifest as { _meta?: Record<string, unknown> })._meta;
  const afps = meta?.[MCP_SERVER_META_KEY] as { name?: string } | undefined;
  return typeof afps?.name === "string" ? afps.name : undefined;
}
