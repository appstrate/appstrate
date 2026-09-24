// SPDX-License-Identifier: Apache-2.0

/**
 * Peer attribution on the per-run docker network (#1458): which runner
 * container, if any, a sidecar listener was reached from. The agent and every
 * runner share that network and nothing on it authenticates itself, so the
 * listeners key their peer checks on the source IP.
 *
 * IPs are read lazily from `docker network inspect`: a runner only gets its
 * endpoint when `docker start` runs, after it was registered. The member table
 * is cached, dropped on `register`, and re-read once when an IP is missing
 * from it (a runner started since the last read).
 */

import { logger } from "./logger.ts";

/**
 * Resolves to the integration id of the runner at `remoteAddress`, `null` for
 * any other member of the run network (the agent), `undefined` when the peer
 * cannot be attributed (not a member, or the inspect failed). Callers refuse
 * on `undefined`.
 */
export type PeerAttribution = (remoteAddress: string) => Promise<string | null | undefined>;

export interface RunnerPeers {
  register(containerName: string, integrationId: string): void;
  integrationOf: PeerAttribution;
}

interface NetworkInspectEntry {
  Containers?: Record<string, { Name?: string; IPv4Address?: string }>;
}

/** `docker network inspect` stdout → IPv4 → container name. */
function parseMembers(stdout: string): Map<string, string> {
  const [network] = JSON.parse(stdout) as NetworkInspectEntry[];
  const members = new Map<string, string>();
  for (const { Name, IPv4Address } of Object.values(network?.Containers ?? {})) {
    const ip = IPv4Address?.split("/")[0];
    if (ip && Name) members.set(ip, Name.replace(/^\//, ""));
  }
  return members;
}

export function createRunnerPeers(options: {
  network: string;
  /** Raw stdout of `docker network inspect <network>`. */
  inspect: (network: string) => Promise<string>;
}): RunnerPeers {
  const runners = new Map<string, string>();
  let members: Promise<Map<string, string> | null> | null = null;

  function load(): Promise<Map<string, string> | null> {
    if (members) return members;
    const pending = options
      .inspect(options.network)
      .then(parseMembers)
      .catch((err: unknown) => {
        // Not cached: the next lookup retries. Every peer check refuses meanwhile.
        if (members === pending) members = null;
        logger.warn("runner peer lookup failed — refusing unattributable peers", {
          network: options.network,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
    members = pending;
    return pending;
  }

  return {
    register(containerName, integrationId) {
      runners.set(containerName, integrationId);
      members = null;
    },
    async integrationOf(remoteAddress) {
      const ip = remoteAddress.replace(/^::ffff:/i, "");
      const wasCached = members !== null;
      const current = load();
      let snapshot = await current;
      if (wasCached && snapshot && !snapshot.has(ip)) {
        if (members === current) members = null;
        snapshot = await load();
      }
      const name = snapshot?.get(ip);
      if (name === undefined) return undefined;
      return runners.get(name) ?? null;
    },
  };
}

/** Transparent-plane peer check: the policy of the runner at a peer IP, `null` for anyone else. */
export function policyForRunnerPeer<P>(
  peers: RunnerPeers,
  policies: ReadonlyMap<string, P>,
): (remoteAddress: string) => Promise<P | null> {
  return async (remoteAddress) => {
    const integrationId = await peers.integrationOf(remoteAddress);
    return typeof integrationId === "string" ? (policies.get(integrationId) ?? null) : null;
  };
}
