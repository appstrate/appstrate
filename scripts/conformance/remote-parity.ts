// SPDX-License-Identifier: Apache-2.0

/**
 * Remote MCP-server tool-parity check (`integration` + `source.kind:remote`).
 *
 * Opens an outbound Streamable-HTTP MCP client to `source.remote.url`
 * (reusing `createMcpHttpClient`), lists tools, and diffs against the
 * manifest's `tools_policy` keys — honoring `allow_undeclared_tools`
 * (server-exposed extras become WARN instead of FAIL).
 *
 * This is a MONITOR check, not a gate: the server is upstream-controlled and
 * can change or go down at any time. Severity reflects that —
 *   - a real parity mismatch (we got a tool list and it differs)  → FAIL
 *   - an SSRF-blocked target (manifest points at internal infra)   → FAIL
 *   - can't test (no credential, or upstream unreachable/auth-gated) → WARN
 *
 * Credentials are opt-in via {@link resolveToken}; absent → the server is
 * probed pre-auth and, if that is rejected, reported as a skipped WARN.
 */

import { createMcpHttpClient } from "@appstrate/mcp-transport";
import type { SystemPackageEntry } from "@appstrate/core/system-packages";
import type { Finding } from "./types.ts";
import { diffToolSets } from "./tool-diff.ts";
import { resolveToken } from "./creds.ts";
import { ssrfGuardedFetch } from "./ssrf-fetch.ts";

const CHECK = "mcp-remote-parity";
const CONNECT_TIMEOUT_MS = 20_000;

/** `source.remote.url` from a remote integration manifest. */
export function remoteUrl(manifest: Record<string, unknown>): string | undefined {
  const source = manifest.source;
  if (source && typeof source === "object") {
    const remote = (source as { remote?: unknown }).remote;
    if (remote && typeof remote === "object") {
      const url = (remote as { url?: unknown }).url;
      if (typeof url === "string") return url;
    }
  }
  return undefined;
}

/** Declared tool names = keys of `tools_policy`. */
export function toolsPolicyKeys(manifest: Record<string, unknown>): string[] {
  const tp = manifest.tools_policy;
  return tp && typeof tp === "object" && !Array.isArray(tp) ? Object.keys(tp) : [];
}

/** Whether the manifest opts out of strict `provided ⊆ declared`. */
export function allowsUndeclared(manifest: Record<string, unknown>): boolean {
  return manifest.allow_undeclared_tools === true;
}

function isSsrfError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("SSRF guard");
}

/** Connect to the remote server, list tools, and diff against the manifest. */
export async function checkMcpRemoteParity(entry: SystemPackageEntry): Promise<Finding[]> {
  const manifest = entry.manifest;
  const url = remoteUrl(manifest);
  if (!url) {
    return [
      {
        packageId: entry.packageId,
        check: CHECK,
        severity: "fail",
        message: "remote integration declares no source.remote.url",
      },
    ];
  }

  const token = resolveToken(entry.packageId);
  const declared = toolsPolicyKeys(manifest);
  const allowUndeclared = allowsUndeclared(manifest);

  const cantTest = (detail: string): Finding => ({
    packageId: entry.packageId,
    check: CHECK,
    severity: "warn",
    message: token
      ? `live check failed: ${detail}`
      : `could not list tools (${detail}); no credential configured — skipped`,
  });

  let client: Awaited<ReturnType<typeof createMcpHttpClient>>;
  try {
    client = await createMcpHttpClient(url, {
      fetch: ssrfGuardedFetch,
      defaultTimeoutMs: CONNECT_TIMEOUT_MS,
      ...(token ? { bearerToken: token } : {}),
    });
  } catch (err) {
    if (isSsrfError(err)) {
      return [
        {
          packageId: entry.packageId,
          check: CHECK,
          severity: "fail",
          message: `SSRF guard blocked source.remote.url (${url})`,
        },
      ];
    }
    return [cantTest(err instanceof Error ? err.message : String(err))];
  }

  try {
    const { tools } = await client.listTools();
    const provided = tools
      .map((t) => (t as { name?: unknown }).name)
      .filter((n): n is string => typeof n === "string");
    const findings = diffToolSets(entry.packageId, declared, provided, {
      check: CHECK,
      allowUndeclared,
    });
    if (findings.length === 0) {
      findings.push({
        packageId: entry.packageId,
        check: CHECK,
        severity: "info",
        message: `parity ok — ${provided.length} tools (${declared.length} declared${
          allowUndeclared ? ", undeclared allowed" : ""
        })`,
      });
    }
    return findings;
  } catch (err) {
    if (isSsrfError(err)) {
      return [
        {
          packageId: entry.packageId,
          check: CHECK,
          severity: "fail",
          message: `SSRF guard blocked a discovery URL for ${url}`,
        },
      ];
    }
    return [cantTest(err instanceof Error ? err.message : String(err))];
  } finally {
    await client.close().catch(() => {});
  }
}
