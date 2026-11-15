// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * The local MCP server run declaration of a `local` integration.
 *
 * A `local` integration declares its MCP server inline (`source.server`, AFPS §7.1: `type`,
 * `entry_point`, `mcp_config`, advisory `tools`) and ships the server payload in its own archive.
 * The Appstrate-specific runtime hints live under the integration manifest's `_meta`:
 * `dev.appstrate/mcp-server` (runtime override) and `dev.appstrate/workspace` (workspace mount).
 *
 * Every function here reads the INTEGRATION manifest.
 */

import type { IntegrationManifest } from "@afps-spec/schema";

// `./mcp-server` is the complete façade for the published subpath; the facts live in
// `./mcp-server-meta.ts` so a browser consumer can read the runtime hint without pulling the
// `@afps-spec/schema` runtime (AJV at module scope, no `sideEffects: false`).
export {
  MCP_SERVER_APPSTRATE_META_KEY,
  MCP_SERVER_RUNTIME_CAPABILITIES,
  MCP_SERVER_RUNTIMES,
  isMcpServerRuntime,
  getMcpServerRuntime,
  effectiveMcpServerType,
} from "./mcp-server-meta.ts";
export type { McpServerRuntime } from "./mcp-server-meta.ts";

/** The `_meta` key carrying the shared-workspace opt-in declaration. */
export const MCP_SERVER_WORKSPACE_META_KEY = "dev.appstrate/workspace";

/**
 * Per-run shared workspace declaration parsed from a local integration
 * manifest. Opt-in: a local server without this `_meta` entry runs
 * with no access to the agent's filesystem (the current default).
 * When present, the platform mounts the per-run shared workspace
 * (a Docker volume in tier 3, a host directory in tier 0-2) at the
 * requested path on the runner.
 *
 * `mount` is the absolute POSIX path inside the runner container/
 * process where the workspace materialises. Defaults to `/workspace`
 * (matches the agent's CWD) — operators should keep the default
 * unless their runner image carves out a non-standard layout.
 *
 * `access` is the manifest-author's intent:
 *   - `"ro"` — read-only mount, the server can read files written by
 *     the agent but cannot mutate them. Safer default for inspection
 *     tools (linters, formatters running in dry-run mode).
 *   - `"rw"` — read-write mount, the server writes results back to
 *     disk for the agent to consume. Required for clone, build,
 *     download tools.
 */
export interface McpServerWorkspaceMount {
  readonly mount: string;
  readonly access: "ro" | "rw";
}

const DEFAULT_WORKSPACE_MOUNT = "/workspace";

/**
 * POSIX-only path canonicaliser — collapses `./` segments, drops empty
 * segments (`//` runs, trailing `/`), preserves leading `/`. Local to
 * this module so core stays node-builtin-free and works in browsers
 * (some core consumers are bundled into the web app).
 *
 * Does NOT resolve `..` — the validator rejects any path containing
 * one before canonicalisation, so this only ever sees clean inputs.
 */
function canonicaliseMount(path: string): string {
  const parts = path.split("/").filter((p) => p !== "" && p !== ".");
  return "/" + parts.join("/");
}

/**
 * Parse the shared-workspace opt-in declared on a local integration manifest.
 * Returns `undefined` when absent (default: no workspace access).
 *
 * Validation is strict — a malformed entry throws rather than being
 * silently degraded. The platform's import-time package validator
 * (the integration manifest's superRefine) runs this and surfaces the
 * throw as a schema issue, so a bad `_meta.workspace` is normally
 * rejected at upload. Spawn-time callers (`integration-spawn-resolver`)
 * run it again as defence-in-depth and may degrade safely (drop the
 * mount + log) rather than abort a whole run on a manifest that
 * slipped past the validator.
 *
 * Rules:
 *   - `mount`, when present, MUST be a non-empty string (omitted →
 *     defaults to `/workspace`)
 *   - `mount` MUST be an absolute POSIX path (`startsWith("/")`)
 *   - `mount` MUST NOT contain `..` traversal segments or control chars
 *   - `mount` MUST NOT be root (`/`) or a kernel-managed prefix
 *     (`/proc/`, `/sys/`, `/dev/`, `/etc/`) — those would break or
 *     shadow the runner's rootfs
 *   - `access` MUST be `"ro"` or `"rw"`; defaults to `"ro"` when
 *     omitted (least-privilege)
 */
export function getMcpServerWorkspaceMount(
  manifest: IntegrationManifest,
): McpServerWorkspaceMount | undefined {
  const meta = (manifest as { _meta?: Record<string, unknown> })._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const entry = meta[MCP_SERVER_WORKSPACE_META_KEY];
  if (entry == null) return undefined;
  if (typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(
      `${MCP_SERVER_WORKSPACE_META_KEY}: expected object, got ${Array.isArray(entry) ? "array" : typeof entry}`,
    );
  }
  const raw = entry as { mount?: unknown; access?: unknown };

  // `mount` omitted → default. Present but not a non-empty string →
  // reject rather than silently coerce to the default, so a typo
  // (`mount: ["/data"]`, `mount: 42`) surfaces at import time instead
  // of producing a `/workspace` mount the author never asked for.
  if (raw.mount !== undefined && (typeof raw.mount !== "string" || raw.mount.length === 0)) {
    throw new Error(
      `${MCP_SERVER_WORKSPACE_META_KEY}.mount: must be a non-empty string when present`,
    );
  }
  const rawMount = typeof raw.mount === "string" ? raw.mount : DEFAULT_WORKSPACE_MOUNT;
  if (!rawMount.startsWith("/")) {
    throw new Error(`${MCP_SERVER_WORKSPACE_META_KEY}.mount: must be an absolute POSIX path`);
  }
  // Reject control characters (NUL, newlines, CR, tab) — they would
  // either break the shell-quoted `-v vol:path` flag or smuggle a
  // second mount on injection-prone consumers. Rejecting at the
  // source removes the need for every downstream to remember.
  // eslint-disable-next-line no-control-regex -- detecting control characters in user input is the point
  if (/[\x00-\x1f]/.test(rawMount)) {
    throw new Error(`${MCP_SERVER_WORKSPACE_META_KEY}.mount: control characters are not allowed`);
  }
  // Reject ANY `..` segment in the raw input (`/work/../etc` and
  // `/work/foo/./../../etc` both contain literal `..` segments once
  // split on `/`). Checking pre-canonicalisation keeps the rule a
  // one-liner — no clever resolution arithmetic to audit.
  if (rawMount.split("/").some((seg) => seg === "..")) {
    throw new Error(
      `${MCP_SERVER_WORKSPACE_META_KEY}.mount: path-traversal segments are not allowed`,
    );
  }
  const mount = canonicaliseMount(rawMount);
  // Root (`/`, or anything that canonicalises to it like `//` or `/.`)
  // would shadow the entire runner rootfs — never a sane mount target.
  if (mount === "/") {
    throw new Error(`${MCP_SERVER_WORKSPACE_META_KEY}.mount: refused root ("/") mount target`);
  }
  const forbiddenPrefixes = ["/proc/", "/sys/", "/dev/", "/etc/"];
  if (forbiddenPrefixes.some((p) => mount === p.replace(/\/$/, "") || mount.startsWith(p))) {
    throw new Error(
      `${MCP_SERVER_WORKSPACE_META_KEY}.mount: refused kernel-managed mount target ${mount}`,
    );
  }

  let access: "ro" | "rw";
  if (raw.access === undefined) {
    access = "ro";
  } else if (raw.access === "ro" || raw.access === "rw") {
    access = raw.access;
  } else {
    throw new Error(`${MCP_SERVER_WORKSPACE_META_KEY}.access: must be "ro" or "rw"`);
  }

  return { mount, access };
}

/**
 * The literal `source.server.mcp_config.env` entries of a `local` integration (AFPS §7.1: literal
 * values only — credentials reach the server through the auth's `delivery.env` / `delivery.files`,
 * which win over these at spawn). Empty when the source is not local or declares none.
 */
export function getLocalServerEnv(manifest: IntegrationManifest): Record<string, string> {
  const env = (manifest as { source?: { server?: { mcp_config?: { env?: unknown } } } }).source
    ?.server?.mcp_config?.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
