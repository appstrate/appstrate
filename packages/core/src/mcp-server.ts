// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS 2.0 mcp-server manifest — re-exported from `@afps-spec/schema`.
 *
 * An `mcp-server` package's `manifest.json` IS a verbatim MCP Bundle (MCPB)
 * manifest plus the AFPS identity contract under `_meta["dev.afps/mcp-server"]`
 * (AFPS §3.4). The schema stays MCPB-conformant; Appstrate-specific runtime
 * hints live under `_meta["dev.appstrate/mcp-server"]` (the blessed extension
 * point) so a built `mcp-server` still runs unmodified in any MCPB host.
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

/** The `_meta` key carrying Appstrate-specific mcp-server runtime hints. */
export const MCP_SERVER_APPSTRATE_META_KEY = "dev.appstrate/mcp-server";

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

/**
 * Read the Appstrate runtime override from `_meta["dev.appstrate/mcp-server"]
 * .runtime`. MCPB's `server.type` enum is `node|python|binary|uv` — it has no
 * `bun`. A bun-native server therefore stays MCPB-conformant (e.g.
 * `server.type: "node"`, `mcp_config.command: "bun"`) and declares `bun` here
 * so the platform's runner picks the bun interpreter/image. Returns `undefined`
 * when absent, in which case callers fall back to `server.type`.
 */
export function getMcpServerRuntime(manifest: McpServerManifest): string | undefined {
  const meta = (manifest as { _meta?: Record<string, unknown> })._meta;
  const appstrate = meta?.[MCP_SERVER_APPSTRATE_META_KEY] as { runtime?: unknown } | undefined;
  return typeof appstrate?.runtime === "string" ? appstrate.runtime : undefined;
}
