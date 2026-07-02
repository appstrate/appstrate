// SPDX-License-Identifier: Apache-2.0

/**
 * Wire contract of the Firecracker guest config drive (`config.json`,
 * snake_case) — the SINGLE definition shared by both sides of the wire:
 *
 *   - producer: `apps/api/src/services/orchestrator/firecracker/vm-config.ts`
 *     (`buildGuestConfig`, host side)
 *   - consumer: `runtime-pi/guest/supervisor.ts` (inside the microVM)
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

/** `config.json` consumed by the guest supervisor (snake_case wire). */
export interface GuestConfig {
  run_id: string;
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
