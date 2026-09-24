// SPDX-License-Identifier: Apache-2.0

/**
 * Which runner, if any, a sidecar listener was reached from (#1458), keyed on
 * source IP from `docker network inspect` (a runner has no IP until started):
 * a miss re-reads once, only while a registered runner was never seen.
 */

import { logger } from "./logger.ts";

/** Runner's integration id; `null` = not a runner, `undefined` = lookup failed (refuse). */
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
    if (ip && Name) members.set(ip, Name);
  }
  return members;
}

export function createRunnerPeers(options: {
  network: string;
  inspect: (network: string) => Promise<string>;
}): RunnerPeers {
  const runners = new Map<string, string>();
  const seen = new Set<string>();
  let members: Promise<Map<string, string> | null> | null = null;

  function load(): Promise<Map<string, string> | null> {
    if (members) return members;
    const pending = options
      .inspect(options.network)
      .then((stdout) => {
        const snapshot = parseMembers(stdout);
        for (const name of snapshot.values()) if (runners.has(name)) seen.add(name);
        return snapshot;
      })
      .catch((err: unknown) => {
        // Not cached: the next lookup retries.
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
    async integrationOf(ip) {
      if (runners.size === 0) return null;
      const wasCached = members !== null;
      const current = load();
      let snapshot = await current;
      if (wasCached && snapshot && !snapshot.has(ip) && seen.size < runners.size) {
        if (members === current) members = null;
        snapshot = await load();
      }
      if (!snapshot) return undefined;
      const name = snapshot.get(ip);
      return (name !== undefined && runners.get(name)) || null;
    },
  };
}

/** Agent forward-proxy peer rule: refuses runners (they have their own listener) and failed lookups. */
export async function admitsAgentProxyPeer(
  attribute: PeerAttribution | null,
  remoteAddress: string,
): Promise<boolean> {
  return attribute === null || (await attribute(remoteAddress)) === null;
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
