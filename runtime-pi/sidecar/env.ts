// SPDX-License-Identifier: Apache-2.0

/**
 * Validated env contract for `runtime-pi/sidecar/server.ts` — the base block
 * every orchestrator writes through `buildBaseSidecarEnv`
 * (`apps/api/src/services/orchestrator/sidecar-env.ts`), in every mode (agent
 * run and connect-run alike). Same hand-rolled idiom as `runtime-pi/env.ts`:
 * the sidecar carries no validation dependency.
 *
 * A missing value is a launcher bug. Defaulting it (`RUN_TOKEN` to `""`,
 * `PLATFORM_API_URL` to localhost) booted a sidecar whose every platform call
 * failed later with an error naming the symptom instead of the cause.
 */

export interface SidecarEnv {
  platformApiUrl: string;
  runToken: string;
  port: number;
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

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Parse the sidecar env, throwing {@link SidecarEnvError} listing every issue at once. */
export function parseSidecarEnv(source: NodeJS.ProcessEnv = process.env): SidecarEnv {
  const issues: string[] = [];

  const platformApiUrl = source.PLATFORM_API_URL;
  if (!platformApiUrl) issues.push("PLATFORM_API_URL: required");
  else if (!isHttpUrl(platformApiUrl))
    issues.push(`PLATFORM_API_URL: must be an http(s) URL (got "${platformApiUrl}")`);

  const runToken = source.RUN_TOKEN;
  if (!runToken) issues.push("RUN_TOKEN: required");

  const port = Number(source.PORT);
  if (!source.PORT) issues.push("PORT: required");
  else if (!Number.isInteger(port) || port <= 0 || port >= 65535)
    issues.push(
      `PORT: must be an integer in 1-65534, the next port hosts the forward proxy (got "${source.PORT}")`,
    );

  if (issues.length > 0) throw new SidecarEnvError(issues);

  return {
    platformApiUrl: platformApiUrl!,
    runToken: runToken!,
    port,
    ...(source.SIDECAR_AUTH_TOKEN ? { sidecarAuthToken: source.SIDECAR_AUTH_TOKEN } : {}),
    ...(source.PROXY_URL ? { proxyUrl: source.PROXY_URL } : {}),
  };
}
