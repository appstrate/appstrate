// SPDX-License-Identifier: Apache-2.0

/**
 * Tool-package manifest extension for declarative MCP server wiring
 * (Phase 4 §D4.2 of #276).
 *
 * AFPS leaves `definition` open for runner-specific fields (§3.4); we
 * use that escape hatch to let a tool package declare itself as a
 * subprocess MCP server without touching the AFPS spec:
 *
 * ```jsonc
 * {
 *   "name": "@scope/notion-mcp",
 *   "version": "1.0.0",
 *   "type": "tool",
 *   "definition": {
 *     "runtime": "mcp-server",
 *     "entrypoint": "./server.js",
 *     "transport": "stdio",
 *     "envAllowList": ["NOTION_TOKEN"],
 *     "trustLevel": "third-party"
 *   }
 * }
 * ```
 *
 * The runner reads `runtime`. If it's `"mcp-server"`, it spawns the
 * entrypoint via {@link SubprocessTransport} and registers the
 * resulting client with the multiplexing host under the package's
 * normalised slug. Anything else flows through the legacy in-process
 * loader.
 *
 * Pure TypeScript validation — no Zod dependency. The schema is small
 * enough that a hand-rolled validator is clearer than another runtime.
 *
 * What this module does NOT do:
 *   - Spawn the subprocess itself with isolation primitives. UID
 *     namespacing, seccomp, cgroups, ulimits are deployment concerns
 *     per §D4.4 — the orchestrator wires them.
 *   - Resolve the entrypoint against an installed path — the caller
 *     passes an absolute or workdir-relative path.
 */

/**
 * Discriminator value for the MCP-server runtime. Any other value
 * (or missing field) means the legacy loader handles the tool.
 */
export const MCP_SERVER_RUNTIME = "mcp-server" as const;

/**
 * Per-server trust level surfaced to the orchestrator. Drives the
 * isolation profile applied at spawn time:
 *
 * - `first-party` — vetted, ships with the platform, can be relaxed.
 * - `third-party` — fully untrusted, gets the full §D4.4 sandbox.
 *
 * Default is `third-party` whenever the field is omitted — fail-safe.
 */
export const TRUST_LEVELS = ["first-party", "third-party"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

/**
 * Stdio is the only transport supported in this PR. HTTP / SSE
 * subprocesses are deferred (D4.1 lists `HttpTransport` as optional
 * for v1).
 */
export const TRANSPORTS = ["stdio"] as const;
export type ManifestTransport = (typeof TRANSPORTS)[number];

/** POSIX env-var-name pattern. Conservative — uppercase only. */
const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/** Hard upper bound on `envAllowList` entries. */
const MAX_ENV_ALLOWLIST = 32;
/** Hard upper bound on entry length. */
const MAX_ENV_VAR_LEN = 64;
/** Lower / upper bounds on `initTimeoutMs`. */
const MIN_INIT_TIMEOUT_MS = 1_000;
const MAX_INIT_TIMEOUT_MS = 300_000;
const DEFAULT_INIT_TIMEOUT_MS = 30_000;

export interface McpServerManifest {
  /** Always {@link MCP_SERVER_RUNTIME}. */
  runtime: typeof MCP_SERVER_RUNTIME;
  /** Path to the executable, relative to the package's installed dir. */
  entrypoint: string;
  /** Optional argv tail. */
  args: string[];
  /** Transport — only `"stdio"` for now. */
  transport: ManifestTransport;
  /** Env vars from the parent process to forward unchanged. */
  envAllowList: string[];
  /** Trust profile to apply at spawn time. */
  trustLevel: TrustLevel;
  /** Connect timeout in ms. */
  initTimeoutMs: number;
}

/**
 * Cheap type guard. Lets a loader decide which dispatch path to take
 * without paying for full validation.
 */
export function isMcpServerManifestDefinition(
  definition: unknown,
): definition is { runtime: typeof MCP_SERVER_RUNTIME } & Record<string, unknown> {
  return (
    typeof definition === "object" &&
    definition !== null &&
    (definition as { runtime?: unknown }).runtime === MCP_SERVER_RUNTIME
  );
}

/**
 * Validate + apply defaults on a tool manifest's `definition`. Throws
 * with a clear message on the first violation — registry publish
 * surfaces the message verbatim per §D4.2.
 */
export function parseMcpServerManifest(definition: unknown): McpServerManifest {
  if (!isMcpServerManifestDefinition(definition)) {
    throw new Error(`McpServerManifest: 'runtime' must equal '${MCP_SERVER_RUNTIME}'`);
  }
  const def = definition as Record<string, unknown>;

  const allowedKeys = new Set([
    "runtime",
    "entrypoint",
    "args",
    "transport",
    "envAllowList",
    "trustLevel",
    "initTimeoutMs",
  ]);
  for (const key of Object.keys(def)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`McpServerManifest: unknown key '${key}'`);
    }
  }

  if (typeof def.entrypoint !== "string" || def.entrypoint.length === 0) {
    throw new Error("McpServerManifest: 'entrypoint' must be a non-empty string");
  }
  if (def.entrypoint.includes("..")) {
    throw new Error("McpServerManifest: 'entrypoint' must not contain '..' path traversal");
  }

  const args = def.args ?? [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    throw new Error("McpServerManifest: 'args' must be an array of strings");
  }

  const transport = def.transport ?? "stdio";
  if (transport !== "stdio") {
    throw new Error(`McpServerManifest: 'transport' must be one of ${TRANSPORTS.join(", ")}`);
  }

  const envAllowList = def.envAllowList ?? [];
  if (!Array.isArray(envAllowList)) {
    throw new Error("McpServerManifest: 'envAllowList' must be an array");
  }
  if (envAllowList.length > MAX_ENV_ALLOWLIST) {
    throw new Error(`McpServerManifest: 'envAllowList' has at most ${MAX_ENV_ALLOWLIST} entries`);
  }
  for (const entry of envAllowList) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_ENV_VAR_LEN) {
      throw new Error(`McpServerManifest: 'envAllowList' entry invalid: ${JSON.stringify(entry)}`);
    }
    if (!ENV_VAR_NAME_RE.test(entry)) {
      throw new Error(
        `McpServerManifest: 'envAllowList' entry must match ${ENV_VAR_NAME_RE}: ${entry}`,
      );
    }
  }

  const trustLevel = def.trustLevel ?? "third-party";
  if (trustLevel !== "first-party" && trustLevel !== "third-party") {
    throw new Error(`McpServerManifest: 'trustLevel' must be one of ${TRUST_LEVELS.join(", ")}`);
  }

  const initTimeoutMs = def.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  if (
    typeof initTimeoutMs !== "number" ||
    !Number.isInteger(initTimeoutMs) ||
    initTimeoutMs < MIN_INIT_TIMEOUT_MS ||
    initTimeoutMs > MAX_INIT_TIMEOUT_MS
  ) {
    throw new Error(
      `McpServerManifest: 'initTimeoutMs' must be an integer in [${MIN_INIT_TIMEOUT_MS}, ${MAX_INIT_TIMEOUT_MS}]`,
    );
  }

  return {
    runtime: MCP_SERVER_RUNTIME,
    entrypoint: def.entrypoint,
    args: args as string[],
    transport: "stdio",
    envAllowList: envAllowList as string[],
    trustLevel,
    initTimeoutMs,
  };
}
