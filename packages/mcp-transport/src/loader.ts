// SPDX-License-Identifier: Apache-2.0

/**
 * Tool-package loader for the manifest-declared MCP server runtime
 * (Phase 4 §D4.2 of #276).
 *
 * Glue between {@link parseMcpServerManifest}, {@link SubprocessTransport},
 * and the SDK `Client`. Exposes one entry point — {@link loadToolMcpServer}
 * — so consumers (orchestrator, runtime-pi, integration tests) get the
 * same, audited spawn-and-connect behaviour.
 *
 * The function NEVER reaches into the manifest authority chain itself
 * (registry signature verification, allowlist checks, …). Callers are
 * expected to have already vetted the manifest before passing it in.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";
import { wrapClient, type AppstrateMcpClient } from "./client.ts";
import { parseMcpServerManifest, type McpServerManifest } from "./manifest.ts";
import { SubprocessTransport } from "./transports/subprocess.ts";

const DEFAULT_CLIENT_INFO: Implementation = {
  name: "appstrate-mcp-loader",
  version: "0.0.0",
};

export interface LoadToolMcpServerOptions {
  /** Working directory the entrypoint resolves from. */
  cwd: string;
  /**
   * Logger called once per stderr line — feeds the §D4.5 transducer
   * that maps `notifications/message` to `log.written` CloudEvents.
   */
  onStderrLine?: (line: string) => void;
  /**
   * Environment variables to inject — typically secrets the package
   * declared via `envAllowList`. Validated against the manifest's
   * allowlist; anything outside it throws before spawn.
   */
  env?: Record<string, string>;
  /** Identification advertised on the MCP `initialize` handshake. */
  clientInfo?: Implementation;
}

/**
 * Spawn a subprocess MCP server declared by a tool manifest, connect
 * an SDK `Client`, and return the {@link AppstrateMcpClient} wrapper.
 *
 * On any failure (validation, spawn, connect timeout) the function
 * tears down the partially constructed transport before propagating
 * the error so callers never see leaked subprocesses.
 */
export async function loadToolMcpServer(
  rawManifest: unknown,
  options: LoadToolMcpServerOptions,
): Promise<AppstrateMcpClient> {
  const manifest = parseMcpServerManifest(rawManifest);
  validateEnv(manifest, options.env);

  const transport = new SubprocessTransport({
    command: manifest.entrypoint,
    args: manifest.args,
    cwd: options.cwd,
    envPassthrough: manifest.envAllowList,
    ...(options.env ? { env: options.env } : {}),
    ...(options.onStderrLine ? { onStderrLine: options.onStderrLine } : {}),
  });

  const client = new Client(options.clientInfo ?? DEFAULT_CLIENT_INFO);

  const connectPromise = client.connect(transport);
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`MCP init timed out after ${manifest.initTimeoutMs}ms`)),
      manifest.initTimeoutMs,
    ).unref?.();
  });

  try {
    await Promise.race([connectPromise, timeoutPromise]);
  } catch (err) {
    await transport.close().catch(() => {});
    throw err;
  }

  return wrapClient(client, transport);
}

/**
 * Reject env entries the manifest didn't whitelist. Keeps the spawn
 * surface narrow — a misconfigured caller can't smuggle DB URLs into
 * the subprocess by passing them through `options.env`.
 */
function validateEnv(manifest: McpServerManifest, env?: Record<string, string>): void {
  if (!env) return;
  const allowed = new Set(manifest.envAllowList);
  for (const key of Object.keys(env)) {
    if (!allowed.has(key)) {
      throw new Error(`loadToolMcpServer: env var '${key}' is not in the manifest's envAllowList`);
    }
  }
}
