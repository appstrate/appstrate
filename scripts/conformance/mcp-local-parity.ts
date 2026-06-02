// SPDX-License-Identifier: Apache-2.0

/**
 * Local MCP-server tool-parity check.
 *
 * For `type: "mcp-server"` packages, spawn the bundled server over stdio
 * (reusing `probeBunCompat`, which performs the `initialize` + `tools/list`
 * handshake), then diff the live tool names against the manifest's declared
 * `tools[]`. Strict both directions — local MCP servers have no
 * `allow_undeclared_tools` escape hatch; the manifest IS the contract.
 *
 * Deterministic (no network, no credentials), so it is gate-eligible.
 */

import { probeBunCompat } from "@appstrate/core/mcp-server-bundle";
import type { SystemPackageEntry } from "@appstrate/core/system-packages";
import type { Finding } from "./types.ts";

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

/**
 * Pure set-diff between declared and live tool names. Strict: every declared
 * tool must be exposed (else the manifest lies / upstream removed it), and
 * every exposed tool must be declared (else an undeclared tool ships).
 */
export function diffTools(packageId: string, declared: string[], provided: string[]): Finding[] {
  const findings: Finding[] = [];
  const providedSet = new Set(provided);
  const declaredSet = new Set(declared);

  for (const name of declared) {
    if (!providedSet.has(name)) {
      findings.push({
        packageId,
        check: CHECK,
        severity: "fail",
        message: `declared tool "${name}" is not exposed by the server`,
      });
    }
  }
  for (const name of provided) {
    if (!declaredSet.has(name)) {
      findings.push({
        packageId,
        check: CHECK,
        severity: "fail",
        message: `server exposes undeclared tool "${name}" (add it to manifest tools[])`,
      });
    }
  }
  return findings;
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

  const probe = await probeBunCompat(entry.files, entryPoint);
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
