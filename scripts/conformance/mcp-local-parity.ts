// SPDX-License-Identifier: Apache-2.0

/**
 * Local MCP-server tool-parity check.
 *
 * For integrations with `source.kind: "local"`, spawn the server bundled in the
 * archive over stdio (`probeLocalServer`, which performs the `initialize` +
 * `tools/list` handshake), then diff the live tool names against the
 * `source.server.tools` catalog. Strict both directions — a local server has no
 * `allow_undeclared_tools` escape hatch; the manifest IS the contract.
 *
 * Deterministic (no network, no credentials), so it is gate-eligible.
 */

import { probeLocalServer } from "./local-server-probe.ts";
import { getLocalServer, getLocalServerTools } from "@appstrate/core/integration";
import type { SystemPackageEntry } from "@appstrate/core/system-packages";
import type { Finding } from "./types.ts";
import { diffToolSets } from "./tool-diff.ts";

const CHECK = "mcp-local-parity";

/** Declared tool names from a local integration manifest's `source.server.tools`. */
export function declaredTools(manifest: Record<string, unknown>): string[] {
  const tools = getLocalServerTools(manifest);
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => (t && typeof t === "object" ? (t as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === "string");
}

/** Manifest `source.server.entry_point` (relative path spawned for the probe). */
export function serverEntryPoint(manifest: Record<string, unknown>): string | undefined {
  return getLocalServer(manifest)?.entry_point;
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
        message: "manifest declares no source.server.entry_point — cannot spawn for parity",
      },
    ];
  }

  const probe = await probeLocalServer(entry.files, entryPoint);
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
