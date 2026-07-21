// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS mcp-server manifest — re-exported from `@afps-spec/schema`.
 *
 * An `mcp-server` package's `manifest.json` is an AFPS-native manifest that
 * carries MCPB-vocabulary fields (`manifest_version`, `server`, `tools`,
 * `user_config`) verbatim, alongside the AFPS identity contract lifted to
 * the root: `type: "mcp-server"`, the scoped `name`, `schema_version`, and
 * `dependencies` (AFPS §3.4 / §11.2). The previous
 * `_meta["dev.afps/mcp-server"]` identity block was removed. The
 * Appstrate-specific runtime hints stay under `_meta["dev.appstrate/mcp-server"]`
 * (the blessed vendor extension point).
 *
 * Strict-MCPB host interoperability is not a goal of AFPS; the manifest
 * carries AFPS-native top-level fields (name, type, schema_version,
 * dependencies) outside the MCPB schema. A publish-time projection to a
 * strict MCPB bundle is reserved for a future minor (AFPS §10.2).
 */

import { z } from "zod";
import {
  mcpServerManifestSchema as afpsMcpServerManifestSchema,
  type McpServerManifest,
} from "@afps-spec/schema";
import { isBlockedHost } from "@appstrate/afps-shared/ssrf";

export type { McpServerManifest };

/**
 * MCPB `user_config` entry shape (Appendix C / MCPB spec). Upstream
 * `@afps-spec/schema` types `user_config` as
 * `z.record(z.string(), z.unknown())` — any value passes. This local refine
 * enforces the MCPB inner shape until the upstream tightening lands.
 * `.passthrough()` preserves forward-compatibility with future MCPB additions.
 */
const userConfigEntrySchema = z
  .object({
    type: z.enum(["string", "number", "boolean", "directory", "file"]),
    title: z.string().min(1),
    description: z.string().optional(),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    multiple: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .loose();

/**
 * Wraps the upstream `mcpServerManifestSchema` with a `.superRefine` that
 * validates each `user_config` entry against the MCPB inner shape. Entries
 * that don't match (missing `type`, invalid `type`, missing `title`, …)
 * surface Zod issues under `["user_config", <key>, …]`.
 */
export const mcpServerManifestSchema = afpsMcpServerManifestSchema.superRefine((m, ctx) => {
  const userConfig = (m as { user_config?: unknown }).user_config;
  if (userConfig && typeof userConfig === "object" && !Array.isArray(userConfig)) {
    for (const [key, entry] of Object.entries(userConfig as Record<string, unknown>)) {
      const result = userConfigEntrySchema.safeParse(entry);
      if (!result.success) {
        for (const issue of result.error.issues) {
          ctx.addIssue({
            code: "custom",
            path: ["user_config", key, ...issue.path],
            message: issue.message,
          });
        }
      }
    }
  }

  // Install-time check for the shared-workspace opt-in. The
  // {@link getMcpServerWorkspaceMount} parser throws synchronously on
  // malformed entries; surface those errors here so the platform's
  // POST/PUT /api/packages/mcp-server validators catch them at upload
  // time rather than at the first run that would spawn the server.
  try {
    getMcpServerWorkspaceMount(m as McpServerManifest);
  } catch (err) {
    ctx.addIssue({
      code: "custom",
      path: ["_meta", MCP_SERVER_WORKSPACE_META_KEY],
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // Browser capability is an Appstrate execution permission, not an
  // open-ended metadata bag. Validate it at package upload so unsafe origins
  // and unknown policy fields never make it to a run resolver.
  try {
    getMcpServerBrowserCapability(m as McpServerManifest);
  } catch (err) {
    ctx.addIssue({
      code: "custom",
      path: ["_meta", MCP_SERVER_APPSTRATE_META_KEY, "capabilities", "browser"],
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

/** The `_meta` key carrying Appstrate-specific mcp-server runtime hints. */
export const MCP_SERVER_APPSTRATE_META_KEY = "dev.appstrate/mcp-server";

/** The `_meta` key carrying the shared-workspace opt-in declaration. */
export const MCP_SERVER_WORKSPACE_META_KEY = "dev.appstrate/workspace";

export type BrowserCapabilityPurpose = "automation" | "connection-acquisition";
export type BrowserCapabilityProtocol = "cdp-v1";
export type BrowserCapabilityProfile = "standard";

/**
 * Normalized browser execution capability declared by a local mcp-server.
 * Chromium remains a companion dependency: `server.type` / `.runtime` still
 * select the package's language runtime.
 */
export interface McpServerBrowserCapability {
  readonly purpose: BrowserCapabilityPurpose;
  readonly protocol: BrowserCapabilityProtocol;
  readonly profile: BrowserCapabilityProfile;
  /** Canonical exact HTTPS origins (`URL.origin`), deduplicated in order. */
  readonly origins: readonly string[];
}

const browserCapabilitySchema = z
  .object({
    purpose: z.enum(["automation", "connection-acquisition"]),
    protocol: z.literal("cdp-v1").default("cdp-v1"),
    profile: z.literal("standard").default("standard"),
    origins: z.array(z.string().min(1).max(2048)).min(1).max(64),
  })
  .strict();

function normalizeBrowserOrigin(raw: string): string {
  if (raw.includes("*")) {
    throw new Error("browser origins must be exact origins; wildcards are not allowed");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid browser origin '${raw}'`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`browser origin '${raw}' must use https`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`browser origin '${raw}' must not contain credentials`);
  }
  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
    throw new Error(`browser origin '${raw}' must not contain a path, query, or fragment`);
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (
    isBlockedHost(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error(`browser origin '${raw}' targets a blocked host`);
  }

  return parsed.origin;
}

/**
 * Parse `_meta["dev.appstrate/mcp-server"].capabilities.browser`.
 *
 * Returns `undefined` when absent. A present declaration is strict and throws
 * on any malformed or unsafe field. Callers receive canonical origins rather
 * than the package's spelling so policy comparisons stay exact.
 */
export function getMcpServerBrowserCapability(
  manifest: McpServerManifest,
): McpServerBrowserCapability | undefined {
  const meta = (manifest as { _meta?: Record<string, unknown> })._meta;
  const appstrate = meta?.[MCP_SERVER_APPSTRATE_META_KEY];
  if (appstrate == null) return undefined;
  if (typeof appstrate !== "object" || Array.isArray(appstrate)) {
    throw new Error(`${MCP_SERVER_APPSTRATE_META_KEY}: expected object`);
  }

  const capabilities = (appstrate as { capabilities?: unknown }).capabilities;
  if (capabilities == null) return undefined;
  if (typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new Error(`${MCP_SERVER_APPSTRATE_META_KEY}.capabilities: expected object`);
  }

  const browser = (capabilities as { browser?: unknown }).browser;
  if (browser == null) return undefined;
  const parsed = browserCapabilitySchema.safeParse(browser);
  if (!parsed.success) {
    throw new Error(
      `${MCP_SERVER_APPSTRATE_META_KEY}.capabilities.browser: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "value"} ${issue.message}`)
        .join("; ")}`,
    );
  }

  const origins = [...new Set(parsed.data.origins.map(normalizeBrowserOrigin))];
  return {
    purpose: parsed.data.purpose,
    protocol: parsed.data.protocol,
    profile: parsed.data.profile,
    origins,
  };
}

/**
 * Per-run shared workspace declaration parsed from an mcp-server
 * manifest. Opt-in: an mcp-server without this `_meta` entry runs
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
 * Parse the shared-workspace opt-in declared on an mcp-server manifest.
 * Returns `undefined` when absent (default: no workspace access).
 *
 * Validation is strict — a malformed entry throws rather than being
 * silently degraded. The platform's install-time package validator
 * (`mcpServerManifestSchema` superRefine) runs this and surfaces the
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
  manifest: McpServerManifest,
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
  // (`mount: ["/data"]`, `mount: 42`) surfaces at install time instead
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
 * Read the Appstrate runtime override from `_meta["dev.appstrate/mcp-server"]
 * .runtime`. MCPB's `server.type` enum is `node|python|binary|uv` — it has no
 * `bun`. A bun-native server therefore keeps an MCPB-vocabulary
 * `server.type: "node"` (with `mcp_config.command: "bun"`) and declares `bun`
 * here so the platform's runner picks the bun interpreter/image. Returns
 * `undefined` when absent, in which case callers fall back to `server.type`.
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
 * AFPS §7.6 + §3.4: when a local-source integration's `delivery.env.<var>`
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
 * Used by the integration spawn resolver (AFPS §7.6 CC-4) to bridge
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
