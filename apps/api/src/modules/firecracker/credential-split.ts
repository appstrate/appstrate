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
 * non-secret configuration (URLs, ids, feature flags), and MMDS has a hard
 * size ceiling. INTEGRATIONS_TO_SPAWN_JSON in particular can be large
 * (bundle bytes + live spawn env) — larger than the MMDS store limit. So
 * the split ENFORCES the ceiling: if the serialized payload would overflow,
 * the largest offending secret keys spill BACK onto the drive (least-bad:
 * that key rides the drive like before, everything else stays brokered)
 * and their NAMES are reported so the caller can warn (never their values).
 *
 * No I/O here — the caller logs the spill and PUTs the payload.
 */

/**
 * Firecracker's MMDS data store is bounded by `--mmds-size-limit`, which
 * defaults to `--http-api-max-payload-size` = 51200 bytes when neither is
 * set (we pass neither — the store keeps the 50 KiB default). The stored
 * blob is exactly the JSON we PUT, so this is the ceiling our payload must
 * fit under.
 */
export const MMDS_STORE_LIMIT_BYTES = 51_200;

/**
 * Headroom kept below {@link MMDS_STORE_LIMIT_BYTES}: the V2 session-token
 * bookkeeping shares the same HTTP payload budget, and Firecracker's
 * internal representation is not byte-identical to our serialized JSON.
 * A conservative margin so a payload that unit-fits also fits live.
 */
export const MMDS_SAFETY_MARGIN_BYTES = 4_096;

/** Effective budget the serialized MMDS payload must not exceed. */
export const MMDS_PAYLOAD_BUDGET_BYTES = MMDS_STORE_LIMIT_BYTES - MMDS_SAFETY_MARGIN_BYTES;

/**
 * Sidecar-env keys that carry secrets (LLM keys, run token, OAuth config,
 * per-integration spawn env with live credentials, cookie-session logins).
 * Everything else in the sidecar env is non-secret configuration.
 */
export const SIDECAR_SECRET_KEYS: readonly string[] = [
  "RUN_TOKEN",
  "PI_API_KEY",
  "PI_LLM_OAUTH_CONFIG_JSON",
  "CONNECT_LOGIN_JSON",
  "INTEGRATIONS_TO_SPAWN_JSON",
];

/** Agent-env keys that carry secrets (the HMAC sink signing secret). */
export const AGENT_SECRET_KEYS: readonly string[] = ["APPSTRATE_SINK_SECRET"];

/** MMDS store contents (snake_case wire — the guest supervisor reads these). */
export interface MmdsPayload {
  sidecar_env: Record<string, string>;
  agent_env: Record<string, string>;
}

export interface CredentialSplit {
  /**
   * Sidecar env for the config drive — the input minus the brokered
   * secrets (plus any that spilled back). `undefined` when the input
   * sidecar env was `undefined` (skipSidecar runs).
   */
  driveSidecarEnv: Record<string, string> | undefined;
  /** Agent env for the config drive — the input minus the brokered secrets. */
  driveAgentEnv: Record<string, string>;
  /** Secrets served in-memory via MMDS. */
  mmdsPayload: MmdsPayload;
  /**
   * Names (never values) of secret keys that had to spill back onto the
   * drive because the MMDS payload exceeded the budget. Empty on the
   * common path. The caller logs these at warn level.
   */
  spilledKeys: string[];
}

/** Serialized byte length of the MMDS payload as it will be PUT. */
function payloadBytes(payload: MmdsPayload): number {
  return Buffer.byteLength(JSON.stringify(payload));
}

/**
 * Split the run's env maps into a config-drive part and an MMDS part.
 * Known-secret keys move to MMDS; if the serialized MMDS payload exceeds
 * {@link MMDS_PAYLOAD_BUDGET_BYTES}, the largest offending secrets spill
 * back to the drive (largest-first) until it fits. Non-secret keys never
 * enter MMDS.
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

  // Spill the largest brokered secrets back to the drive until the payload
  // fits. "Largest" = serialized value bytes: shedding the biggest key
  // reclaims the most budget per spill, so the fewest keys leave MMDS.
  const spilledKeys: string[] = [];
  while (payloadBytes(payload) > MMDS_PAYLOAD_BUDGET_BYTES) {
    const candidates: Array<{ map: "sidecar_env" | "agent_env"; key: string; bytes: number }> = [];
    for (const key of Object.keys(payload.sidecar_env)) {
      candidates.push({
        map: "sidecar_env",
        key,
        bytes: Buffer.byteLength(payload.sidecar_env[key] as string),
      });
    }
    for (const key of Object.keys(payload.agent_env)) {
      candidates.push({
        map: "agent_env",
        key,
        bytes: Buffer.byteLength(payload.agent_env[key] as string),
      });
    }
    if (candidates.length === 0) break; // Nothing left to shed — payload is irreducible.
    candidates.sort((a, b) => b.bytes - a.bytes);
    const largest = candidates[0] as { map: "sidecar_env" | "agent_env"; key: string };
    if (largest.map === "sidecar_env") {
      // A sidecar secret can only spill onto a sidecar drive map.
      const value = payload.sidecar_env[largest.key] as string;
      delete payload.sidecar_env[largest.key];
      if (driveSidecarEnv) driveSidecarEnv[largest.key] = value;
    } else {
      const value = payload.agent_env[largest.key] as string;
      delete payload.agent_env[largest.key];
      driveAgentEnv[largest.key] = value;
    }
    spilledKeys.push(largest.key);
  }

  return { driveSidecarEnv, driveAgentEnv, mmdsPayload: payload, spilledKeys };
}
