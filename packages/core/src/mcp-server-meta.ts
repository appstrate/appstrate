// SPDX-License-Identifier: Apache-2.0

/**
 * mcp-server facts that carry no dependencies.
 *
 * Split out of `./mcp-server.ts` for one reason: that module imports
 * `@afps-spec/schema`, which does `new Ajv2020(...)` at module scope and ships
 * no `sideEffects: false`, so a bundler cannot drop it. The SPA needs the
 * runtime hint to label an mcp-server correctly and needs nothing else from
 * there — importing the schema module for it cost **65 kB gzipped** on the
 * integration detail page, measured on the emitted chunk graph.
 *
 * Everything here is re-exported from `./mcp-server.ts`, so backend callers are
 * unaffected and there is still exactly one declaration of each fact. Keep this
 * module free of VALUE imports; `import type` is erased at build and is fine.
 */

import type { McpServerManifest } from "@afps-spec/schema";

export type { McpServerManifest };

/** The `_meta` key carrying Appstrate-specific mcp-server runtime hints. */
export const MCP_SERVER_APPSTRATE_META_KEY = "dev.appstrate/mcp-server";

/**
 * Runtime identifiers accepted by both integration runtime adapters. This is
 * the public capability registry used by package authoring/discovery; adapter
 * implementation details (image refs and host commands) remain private.
 */
export const MCP_SERVER_RUNTIME_CAPABILITIES = {
  node: {
    manifestVersion: "0.3",
    manifestServerType: "node",
    manifestCommand: "node",
    manifestArgsBeforeEntryPoint: [],
    entryPoint: "JavaScript entry point present in the archive",
  },
  bun: {
    manifestVersion: "0.3",
    manifestServerType: "node",
    manifestCommand: "bun",
    manifestArgsBeforeEntryPoint: [],
    entryPoint: "JavaScript or TypeScript entry point present in the archive",
    runtimeOverride: "bun",
  },
  python: {
    manifestVersion: "0.3",
    manifestServerType: "python",
    manifestCommand: "python3",
    manifestArgsBeforeEntryPoint: [],
    entryPoint: "Python entry point present in the archive",
  },
  uv: {
    manifestVersion: "0.4",
    manifestServerType: "uv",
    manifestCommand: "uv",
    manifestArgsBeforeEntryPoint: ["run"],
    entryPoint: "Python entry point present in the archive; uv resolves project dependencies",
  },
  binary: {
    manifestVersion: "0.3",
    manifestServerType: "binary",
    manifestCommand: null,
    manifestArgsBeforeEntryPoint: [],
    entryPoint: "Executable entry point present in the archive",
  },
} as const;

export type McpServerRuntime = keyof typeof MCP_SERVER_RUNTIME_CAPABILITIES;

export const MCP_SERVER_RUNTIMES = Object.freeze(
  Object.keys(MCP_SERVER_RUNTIME_CAPABILITIES) as McpServerRuntime[],
);

export function isMcpServerRuntime(value: unknown): value is McpServerRuntime {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(MCP_SERVER_RUNTIME_CAPABILITIES, value)
  );
}

/**
 * Read the Appstrate runtime override from `_meta["dev.appstrate/mcp-server"]
 * .runtime`. MCPB's `server.type` enum is `node|python|binary|uv` — it has no
 * `bun`. A bun-native server therefore keeps an MCPB-vocabulary
 * `server.type: "node"` (with `mcp_config.command: "bun"`) and declares `bun`
 * here so the platform's runner picks the bun interpreter/image. Returns
 * `undefined` when absent, in which case callers fall back to `server.type`.
 */
export function getMcpServerRuntime(manifest: McpServerManifest): McpServerRuntime | undefined {
  const meta = (manifest as { _meta?: Record<string, unknown> })._meta;
  const appstrate = meta?.[MCP_SERVER_APPSTRATE_META_KEY] as { runtime?: unknown } | undefined;
  return isMcpServerRuntime(appstrate?.runtime) ? appstrate.runtime : undefined;
}

/**
 * The runtime an mcp-server ACTUALLY spawns under: the Appstrate `_meta`
 * override when present, the MCPB `server.type` otherwise.
 *
 * Every caller that needs a runtime must decide it the same way, and the
 * fallback is the half that drifts. It already did: the connect-login path
 * forwarded `server.type` verbatim while the agent-run path applied the
 * override, so the SAME bun-native package spawned under `bun` for an agent run
 * and under `node` for a connect login. The rule lives here so a third reader
 * cannot re-derive it a fourth way.
 *
 * `server.type` is returned VERBATIM rather than narrowed to
 * {@link McpServerRuntime}: the SPA reads unvalidated DRAFT manifests, where an
 * author's typo must still be displayed as written instead of silently
 * vanishing. Spawn callers read a schema-validated manifest, where the value is
 * always an MCPB type. `undefined` means neither source declared one — for a
 * spawn that is "not runnable", and it is the caller's job to fail closed on it.
 */
export function effectiveMcpServerType(manifest: McpServerManifest): string | undefined {
  const type = (manifest as { server?: { type?: unknown } }).server?.type;
  return (
    getMcpServerRuntime(manifest) ??
    (typeof type === "string" && type.trim() !== "" ? type : undefined)
  );
}
