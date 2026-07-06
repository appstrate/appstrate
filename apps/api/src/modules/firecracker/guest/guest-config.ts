// SPDX-License-Identifier: Apache-2.0

/**
 * Wire contract of the Firecracker guest config drive (`config.json`,
 * snake_case) — the SINGLE definition shared by both sides of the wire:
 *
 *   - producer: `apps/api/src/services/orchestrator/firecracker/vm-config.ts`
 *     (`buildGuestConfig`, host side)
 *   - consumer: `apps/api/src/modules/firecracker/guest/supervisor.ts` (inside the microVM)
 *
 * Types only — no imports, no side effects. The supervisor bundle stays
 * self-contained (`bun build` erases type-only imports) and the host side
 * imports it type-only across the workspace boundary.
 */

export interface GuestNetworkConfig {
  /** Loopback-alias IP of the platform API, reachable via the guest's gateway. */
  platform_ip: string;
  platform_port: number;
}

/**
 * Where the run's raw credentials come from.
 *   - `"mmds"`: the secret keys are NOT on the config drive — the
 *     supervisor fetches them from the Firecracker MMDS store at boot and
 *     merges them over the drive env maps (FIRECRACKER_CREDENTIAL_BROKER=mmds).
 *   - `"inline"`: the drive env maps already carry every credential
 *     (FIRECRACKER_CREDENTIAL_BROKER=config-drive).
 */
export interface GuestCredentialsConfig {
  source: "mmds" | "inline";
}

/** `config.json` consumed by the guest supervisor (snake_case wire). */
export interface GuestConfig {
  run_id: string;
  /**
   * How the supervisor obtains the run's secrets — see
   * {@link GuestCredentialsConfig}. Optional on the wire: a config without
   * it (older producer, hand-written) is treated as `"inline"` (secrets on
   * the drive). `buildGuestConfig` always emits it.
   */
  credentials?: GuestCredentialsConfig;
  /**
   * Per-run random nonce the supervisor embeds in its serial-console exit
   * marker (`APPSTRATE_EXIT:<nonce>:<code>`). Workloads share the console
   * but never see the config drive (unmounted before they start), so a
   * marker carrying the nonce provably came from the supervisor — a
   * pre-printed forgery cannot turn a killed run into a success.
   */
  exit_marker_nonce: string;
  network: GuestNetworkConfig;
  sidecar: {
    enabled: boolean;
    env: Record<string, string>;
  };
  agent: {
    env: Record<string, string>;
    /**
     * skipSidecar runs have no in-guest egress proxy — the agent itself
     * must reach the upstream LLM, so the supervisor skips the uid-based
     * egress restriction for it. Sidecar-backed runs keep it: the agent
     * may only talk to loopback (sidecar) and the platform sink.
     */
    unrestricted_egress: boolean;
    /**
     * Agent command override — NEVER set on production runs (the guest
     * supervisor defaults to the baked runtime entrypoint). Exists for
     * the dev smoke harness, which validates the boot machinery with a
     * trivial command instead of a live platform run.
     */
    argv?: string[];
  };
}
