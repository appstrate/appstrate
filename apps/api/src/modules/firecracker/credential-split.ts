// SPDX-License-Identifier: Apache-2.0

/**
 * Credential broker split (FIRECRACKER_CREDENTIAL_BROKER=mmds).
 *
 * Pure function: given the sidecar + agent env maps a run would otherwise
 * carry wholesale on the config drive, it moves the KNOWN-SECRET keys into
 * an MMDS payload the daemon serves in-memory (see
 * orchestrator.startWorkload → PUT /mmds) and leaves every non-secret key
 * on the drive. The guest supervisor fetches the MMDS payload at boot and
 * merges it back over the drive maps (see guest/supervisor.ts).
 *
 * Why a split, not a wholesale move: the drive still carries the run's
 * non-secret configuration (URLs, ids, feature flags) — only secrets need
 * the in-memory path.
 *
 * A known secret NEVER falls back onto the drive. When the serialized
 * payload exceeds Firecracker's default 50 KiB store, the orchestrator
 * raises the VMM's store/API payload limits at spawn
 * (`--mmds-size-limit` / `--http-api-max-payload-size`) up to
 * FIRECRACKER_MMDS_MAX_BYTES, and FAIL-CLOSES the run beyond that ceiling
 * — silently degrading a known secret to at-rest storage is worse than
 * failing the run loudly.
 *
 * No I/O here — the caller PUTs the payload.
 */

/**
 * Firecracker's MMDS data store is bounded by `--mmds-size-limit`, which
 * defaults to `--http-api-max-payload-size` = 51200 bytes when neither is
 * set. The stored blob is exactly the JSON we PUT; payloads above this
 * default make the orchestrator pass both flags explicitly.
 */
export const MMDS_STORE_LIMIT_BYTES = 51_200;

/**
 * Headroom added on top of the serialized payload when sizing the VMM's
 * store: the V2 session-token bookkeeping shares the same HTTP payload
 * budget, and Firecracker's internal representation is not byte-identical
 * to our serialized JSON. A conservative margin so a payload that
 * unit-fits also fits live.
 */
export const MMDS_SAFETY_MARGIN_BYTES = 4_096;

/**
 * Sidecar-env keys that carry secrets (LLM keys, run token, OAuth config,
 * per-integration spawn env with live credentials, cookie-session logins,
 * the forward-proxy URL — it can embed `user:pass@host` credentials).
 * Everything else in the sidecar env is non-secret configuration.
 *
 * Coverage-enforced: test/unit/credential-classification.test.ts fails
 * whenever the sidecar env builders emit a key not classified here or
 * there.
 */
export const SIDECAR_SECRET_KEYS: readonly string[] = [
  "RUN_TOKEN",
  "PI_API_KEY",
  "PI_LLM_OAUTH_CONFIG_JSON",
  "CONNECT_LOGIN_JSON",
  "BROWSER_CONNECT_JSON",
  "CONNECT_RESULT_KEY",
  "INTEGRATIONS_TO_SPAWN_JSON",
  "PROXY_URL",
];

/**
 * Agent-env keys that carry secrets: the HMAC sink signing secret, and —
 * on skipSidecar (direct-provider) runs — the REAL model API key
 * (sidecar-backed runs only ever put the placeholder in the agent env,
 * which is harmless to broker too).
 */
export const AGENT_SECRET_KEYS: readonly string[] = ["APPSTRATE_SINK_SECRET", "MODEL_API_KEY"];

/** MMDS store contents (snake_case wire — the guest supervisor reads these). */
export interface MmdsPayload {
  sidecar_env: Record<string, string>;
  agent_env: Record<string, string>;
}

export interface CredentialSplit {
  /**
   * Sidecar env for the config drive — the input minus the brokered
   * secrets. `undefined` when the input sidecar env was `undefined`
   * (skipSidecar runs).
   */
  driveSidecarEnv: Record<string, string> | undefined;
  /** Agent env for the config drive — the input minus the brokered secrets. */
  driveAgentEnv: Record<string, string>;
  /** Secrets served in-memory via MMDS. */
  mmdsPayload: MmdsPayload;
}

/** Serialized byte length of the MMDS payload as it will be PUT. */
export function mmdsPayloadBytes(payload: MmdsPayload): number {
  return Buffer.byteLength(JSON.stringify(payload));
}

/**
 * Split the run's env maps into a config-drive part and an MMDS part.
 * Known-secret keys move to MMDS unconditionally; non-secret keys never
 * enter MMDS. Capacity enforcement is the caller's job (see the module
 * doc-comment) — this function never moves a secret back to the drive.
 */
export function splitCredentials(
  sidecarEnv: Record<string, string> | undefined,
  agentEnv: Record<string, string>,
): CredentialSplit {
  const driveSidecarEnv = sidecarEnv ? { ...sidecarEnv } : undefined;
  const driveAgentEnv = { ...agentEnv };
  const payload: MmdsPayload = { sidecar_env: {}, agent_env: {} };

  if (driveSidecarEnv) {
    for (const key of SIDECAR_SECRET_KEYS) {
      if (key in driveSidecarEnv) {
        payload.sidecar_env[key] = driveSidecarEnv[key] as string;
        delete driveSidecarEnv[key];
      }
    }
  }
  for (const key of AGENT_SECRET_KEYS) {
    if (key in driveAgentEnv) {
      payload.agent_env[key] = driveAgentEnv[key] as string;
      delete driveAgentEnv[key];
    }
  }

  return { driveSidecarEnv, driveAgentEnv, mmdsPayload: payload };
}
