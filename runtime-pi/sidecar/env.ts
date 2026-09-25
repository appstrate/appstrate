// SPDX-License-Identifier: Apache-2.0

/**
 * Validated env contract for the sidecar: the base block every orchestrator
 * writes through `buildBaseSidecarEnv`. A missing value is a launcher bug, so
 * it fails at boot rather than on the first platform call.
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

  if (issues.length > 0) throw new SidecarEnvError(issues);

  return {
    platformApiUrl: platformApiUrl!,
    runToken: runToken!,
    port: port!,
    forwardProxyPort: forwardProxyPort!,
    ...(source.SIDECAR_AUTH_TOKEN ? { sidecarAuthToken: source.SIDECAR_AUTH_TOKEN } : {}),
    ...(source.PROXY_URL ? { proxyUrl: source.PROXY_URL } : {}),
  };
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
