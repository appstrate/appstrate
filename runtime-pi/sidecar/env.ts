// SPDX-License-Identifier: Apache-2.0

/**
 * Validated env contract for the sidecar: the base block every orchestrator
 * writes through `buildBaseSidecarEnv`, plus the run values `sidecar-env.ts`
 * serialises. A missing or malformed value is a launcher bug, so it fails at
 * boot rather than on the first platform call — or, for a JSON value, instead
 * of silently dropping the tools or the schema it carries.
 */

import { normalizeHttpUrl } from "@appstrate/core/url";

export interface SidecarEnv {
  platformApiUrl: string;
  runToken: string;
  port: number;
  /** The agent's forward proxy listener — its own port, never derived from `port`. */
  forwardProxyPort: number;
  /** Absent on a connect-run, which never serves the agent surface. */
  sidecarAuthToken?: string;
  /** Upstream egress proxy — set only when the run resolved one. */
  proxyUrl?: string;
  /** `RUNTIME_TOOLS_JSON`: the runtime tools the agent selected. */
  runtimeTools: string[];
  /** `OUTPUT_SCHEMA`: the agent's output schema, for the `output` tool. */
  outputSchema?: Record<string, unknown>;
  /** `CONNECT_RESULT_KEY`, required with `CONNECT_LOGIN_JSON` (connect mode). */
  connectResultKey?: Buffer;
}

export class SidecarEnvError extends Error {
  override readonly name = "SidecarEnvError";
  readonly issues: ReadonlyArray<string>;
  constructor(issues: ReadonlyArray<string>) {
    // One line: connect mode relays this message on a single stdout sentinel.
    super(`sidecar env invalid: ${issues.join("; ")}`);
    this.issues = issues;
  }
}

export function parseSidecarEnv(source: NodeJS.ProcessEnv = process.env): SidecarEnv {
  const issues: string[] = [];

  const platformApiUrl = source.PLATFORM_API_URL;
  if (!platformApiUrl) issues.push("PLATFORM_API_URL: required");
  else if (normalizeHttpUrl(platformApiUrl) === null)
    issues.push(`PLATFORM_API_URL: must be an http(s) URL (got "${platformApiUrl}")`);

  const runToken = source.RUN_TOKEN;
  if (!runToken) issues.push("RUN_TOKEN: required");

  const port = parsePort("PORT", source.PORT, issues);
  const forwardProxyPort = parsePort("FORWARD_PROXY_PORT", source.FORWARD_PROXY_PORT, issues);
  if (port !== null && port === forwardProxyPort)
    issues.push(`FORWARD_PROXY_PORT: must differ from PORT (both "${port}")`);

  const runtimeTools = parseJson("RUNTIME_TOOLS_JSON", source.RUNTIME_TOOLS_JSON, issues, (v) =>
    Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null,
  );
  const outputSchema = parseJson("OUTPUT_SCHEMA", source.OUTPUT_SCHEMA, issues, (v) =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null,
  );
  const connectResultKey = parseConnectResultKey(source, issues);

  if (issues.length > 0) throw new SidecarEnvError(issues);

  return {
    platformApiUrl: platformApiUrl!,
    runToken: runToken!,
    port: port!,
    forwardProxyPort: forwardProxyPort!,
    ...(source.SIDECAR_AUTH_TOKEN ? { sidecarAuthToken: source.SIDECAR_AUTH_TOKEN } : {}),
    ...(source.PROXY_URL ? { proxyUrl: source.PROXY_URL } : {}),
    runtimeTools: runtimeTools ?? [],
    ...(outputSchema ? { outputSchema } : {}),
    ...(connectResultKey ? { connectResultKey } : {}),
  };
}

/** Absent → `undefined`; present but unparseable or of the wrong shape → an issue. */
function parseJson<T>(
  name: string,
  raw: string | undefined,
  issues: string[],
  shape: (value: unknown) => T | null,
): T | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    issues.push(`${name}: must be valid JSON`);
    return undefined;
  }
  const parsed = shape(value);
  if (parsed === null) issues.push(`${name}: unexpected shape`);
  return parsed ?? undefined;
}

/** Without it a connect-run cannot emit its bundle without leaking it, so it refuses. */
function parseConnectResultKey(source: NodeJS.ProcessEnv, issues: string[]): Buffer | undefined {
  if (!source.CONNECT_LOGIN_JSON) return undefined;
  if (!source.CONNECT_RESULT_KEY) {
    issues.push("CONNECT_RESULT_KEY: required in connect mode");
    return undefined;
  }
  const key = Buffer.from(source.CONNECT_RESULT_KEY, "base64");
  if (key.length !== 32) issues.push("CONNECT_RESULT_KEY: must decode to 32 bytes (AES-256 key)");
  return key;
}

function parsePort(name: string, raw: string | undefined, issues: string[]): number | null {
  if (!raw) {
    issues.push(`${name}: required`);
    return null;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    issues.push(`${name}: must be an integer in 1-65535 (got "${raw}")`);
    return null;
  }
  return port;
}
