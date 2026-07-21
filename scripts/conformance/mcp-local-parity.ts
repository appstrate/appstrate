// SPDX-License-Identifier: Apache-2.0

/**
 * Local MCP-server tool-parity check.
 *
 * For `type: "mcp-server"` packages, spawn the bundled server over stdio
 * with the manifest-selected runtime, perform the `initialize` + `tools/list`
 * handshake, then diff the live tool names against the manifest's declared
 * `tools[]`. Strict both directions — local MCP servers have no
 * `allow_undeclared_tools` escape hatch; the manifest IS the contract.
 *
 * Deterministic (no network, no credentials), so it is gate-eligible.
 */

import { probeBunCompat, probeStdioCompat } from "@appstrate/core/mcp-server-bundle";
import type { SystemPackageEntry } from "@appstrate/core/system-packages";
import { join } from "node:path";
import type { Finding } from "./types.ts";
import { diffToolSets } from "./tool-diff.ts";

const CHECK = "mcp-local-parity";

/** Declared tool names from a `type: "mcp-server"` manifest's `tools[]`. */
export function declaredTools(manifest: Record<string, unknown>): string[] {
  const tools = manifest.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => (t && typeof t === "object" ? (t as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === "string");
}

/** Manifest `server.entry_point` (relative path spawned for the probe). */
export function serverEntryPoint(manifest: Record<string, unknown>): string | undefined {
  const server = manifest.server;
  if (server && typeof server === "object") {
    const ep = (server as { entry_point?: unknown }).entry_point;
    if (typeof ep === "string") return ep;
  }
  return undefined;
}

/** Appstrate-private runtime override carried by reviewed system packages. */
export function serverRuntime(manifest: Record<string, unknown>): string | undefined {
  const meta = manifest._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const appstrate = (meta as Record<string, unknown>)["dev.appstrate/mcp-server"];
  if (!appstrate || typeof appstrate !== "object") return undefined;
  const runtime = (appstrate as { runtime?: unknown }).runtime;
  return typeof runtime === "string" ? runtime : undefined;
}

/**
 * Pure set-diff between declared and live tool names. Strict both directions —
 * local MCP servers have no `allow_undeclared_tools` escape hatch, so the
 * manifest IS the contract. Delegates to the shared {@link diffToolSets}.
 */
export function diffTools(packageId: string, declared: string[], provided: string[]): Finding[] {
  return diffToolSets(packageId, declared, provided, { check: CHECK });
}

/** Spawn the local server, list its tools, and diff against the manifest. */
export async function checkMcpLocalParity(entry: SystemPackageEntry): Promise<Finding[]> {
  const manifest = entry.manifest;
  const entryPoint = serverEntryPoint(manifest);
  if (!entryPoint) {
    return [
      {
        packageId: entry.packageId,
        check: CHECK,
        severity: "fail",
        message: "manifest declares no server.entry_point — cannot spawn for parity",
      },
    ];
  }

  const runtime = serverRuntime(manifest);
  const probe =
    runtime === "browser-use"
      ? await probeStdioCompat(entry.files, entryPoint, {
          executable: process.env.APPSTRATE_BROWSER_USE_PYTHON ?? "python3",
          executableArgs: ["-u"],
          env: {
            PYTHONPATH: join(import.meta.dir, "../../runtime-pi/runners/browser-use"),
            PYTHONDONTWRITEBYTECODE: "1",
            ANONYMIZED_TELEMETRY: "false",
            BROWSER_USE_DISABLE_EXTENSIONS: "1",
          },
        })
      : await probeBunCompat(entry.files, entryPoint);
  if (!probe.ok) {
    return [
      {
        packageId: entry.packageId,
        check: CHECK,
        severity: "fail",
        message: `server probe failed: ${probe.reason ?? "unknown error"}`,
      },
    ];
  }

  const declared = declaredTools(manifest);
  const provided = probe.toolNames ?? [];
  const findings = diffTools(entry.packageId, declared, provided);
  if (findings.length === 0) {
    findings.push({
      packageId: entry.packageId,
      check: CHECK,
      severity: "info",
      message: `parity ok — ${provided.length} tools declared and exposed`,
    });
  }
  return findings;
}
