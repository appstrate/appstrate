// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS 2.0.2 mcp-server manifest — re-exported from `@afps-spec/schema`.
 *
 * An `mcp-server` package's `manifest.json` IS a verbatim MCP Bundle (MCPB)
 * manifest extended with the AFPS identity contract lifted to the root:
 * `type: "mcp-server"`, the scoped `name`, `schema_version`, and
 * `dependencies` (AFPS 2.0.2 §3.4 / §11.2). The previous
 * `_meta["dev.afps/mcp-server"]` identity block was removed in 2.0.2. The
 * Appstrate-specific runtime hints stay under `_meta["dev.appstrate/mcp-server"]`
 * (the blessed vendor extension point) so a built `mcp-server` still runs
 * unmodified in any MCPB host.
 */

import {
  mcpServerManifestSchema,
  mcpServerTypeEnum,
  type McpServerManifest,
} from "@afps-spec/schema";

export { mcpServerManifestSchema, mcpServerTypeEnum };
export type { McpServerManifest };

/** The `_meta` key carrying Appstrate-specific mcp-server runtime hints. */
export const MCP_SERVER_APPSTRATE_META_KEY = "dev.appstrate/mcp-server";

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

/**
 * Read the MCPB `server.mcp_config.env` map — the placeholders an mcp-server
 * declares for `${user_config.<key>}` substitution at MCPB-host launch time.
 *
 * AFPS 2.0.2 §7.6 + §3.4: when a local-source integration's `delivery.env.<var>`
 * carries `user_config_key`, the AFPS build step injects the rendered value
 * into the referenced mcp-server's `mcp_config.env` template so the same
 * package runs in both the Appstrate runtime AND a standalone MCPB host.
 *
 * Returns the env map (typically `Record<string, string>` with literal values
 * or `"${user_config.<key>}"` placeholders) or `null` when absent / malformed.
 */
export function getMcpServerMcpConfigEnv(
  manifest: McpServerManifest,
): Record<string, string> | null {
  const server = (manifest as { server?: { mcp_config?: { env?: unknown } } }).server;
  const env = server?.mcp_config?.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Pre-render `${user_config.<key>}` placeholders in an MCPB `mcp_config.env`
 * template against a substitution map. Returns the rendered env block — keys
 * with no placeholder pass through unchanged; keys whose placeholder resolves
 * to a value in `substitutions` are replaced.
 *
 * Used by the integration spawn resolver (AFPS 2.0.2 §7.6 CC-4) to bridge
 * `delivery.env.<var>.user_config_key` → mcp-server `mcp_config.env` template.
 * The substitution map's keys are the `user_config_key` names; the values are
 * the rendered credential strings.
 */
const USER_CONFIG_REF = /\$\{user_config\.([A-Za-z0-9_]+)\}/g;
export function renderMcpConfigEnv(
  envTemplate: Readonly<Record<string, string>>,
  substitutions: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(envTemplate)) {
    out[k] = v.replace(USER_CONFIG_REF, (_match, key: string) => substitutions[key] ?? "");
  }
  return out;
}
