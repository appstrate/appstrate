// SPDX-License-Identifier: Apache-2.0

/**
 * Guest egress firewall (nftables `inet` family), default-deny — the pure
 * script builder the supervisor applies before any workload starts. No
 * imports beyond the type-only wire contract, so the supervisor bundle stays
 * self-contained.
 */

import type { GuestNetworkConfig } from "./guest-config.ts";

export const GUEST_SIDECAR_UID = "1000";
export const GUEST_AGENT_UID = "1001";
const GUEST_RUNNER_UID = "1002";

/**
 * Firecracker MMDS link-local service address (matches the host-side
 * mmds-config in vm-config.ts). The credential broker serves the run's
 * secrets here; the supervisor fetches them at boot, then the firewall
 * drops all further access.
 */
export const MMDS_IPV4_ADDRESS = "169.254.169.254";

/**
 * The chain policy is DROP with an explicit allowlist — a denylist keyed
 * on the agent uid alone would let any OTHER uid (root helpers, a future
 * user, a compromised process that changed uid) egress freely:
 *
 *   - loopback: always allowed (agent ↔ sidecar traffic rides 127.0.0.1).
 *   - root (supervisor): allowed — it is the trust anchor of the guest.
 *   - sidecar uid: full egress (it fronts the LLM proxy + forward proxy).
 *   - runner uid: full egress (integration MCP servers call external APIs).
 *   - agent uid: loopback + the platform sink only.
 *   - everything else — any uid, any socketless packet — is dropped.
 *
 * DNS to the configured resolvers is allowed for whoever has egress
 * (sidecar/runner) via the general accept rules — no special-casing needed.
 */
export function buildGuestFirewallScript(network: GuestNetworkConfig): string {
  return [
    `table inet appstrate_guest {`,
    `  chain output {`,
    `    type filter hook output priority filter; policy drop;`,
    // Credential broker: by the time this firewall is applied the
    // supervisor has already fetched the run's secrets from MMDS. Slam the
    // link-local metadata address shut for EVERY uid — including root — so
    // no workload can ever read the credential store back. First rule =
    // highest precedence (drops before the skuid-0/sidecar/runner accepts
    // below). Unconditional: in config-drive mode MMDS is not even
    // configured, so this is a harmless belt-and-suspenders (the host
    // forward chain also drops 169.254/16).
    `    ip daddr ${MMDS_IPV4_ADDRESS} drop`,
    `    oifname "lo" accept`,
    `    meta skuid 0 accept`,
    `    meta skuid ${GUEST_SIDECAR_UID} accept`,
    `    meta skuid ${GUEST_RUNNER_UID} accept`,
    `    meta skuid ${GUEST_AGENT_UID} ip daddr 127.0.0.1 accept`,
    `    meta skuid ${GUEST_AGENT_UID} ip daddr ${network.platform_ip} tcp dport ${network.platform_port} accept`,
    `  }`,
    `}`,
    ``,
  ].join("\n");
}
