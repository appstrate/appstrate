// SPDX-License-Identifier: Apache-2.0

/**
 * Guest egress firewall (nftables `inet` family), default-deny — the pure
 * script builder the supervisor applies before any workload starts. No
 * imports beyond the type-only wire contract, so the supervisor bundle stays
 * self-contained.
 */

import type { GuestNetworkConfig } from "./guest-config.ts";

export const GUEST_SIDECAR_UID = "1000";
const GUEST_AGENT_UID = "1001";

/**
 * Integration runner uid pool: the sidecar gives each runner it spawns its
 * own uid from this range (through the setuid `appstrate-runner-exec`
 * wrapper), so the kernel attributes every socket to exactly one runner and
 * no runner can read a sibling's /proc/<pid>/environ. Mirrored by the
 * `RUNNER_UID_*` defines in runner-exec.c and the `runner<i>` users baked by
 * Dockerfile.rootfs — pinned together by runner-uid-contract.test.ts.
 */
export const GUEST_RUNNER_UID_FIRST = 1100;
export const GUEST_RUNNER_UID_COUNT = 64;
/** The pool as an inclusive `first-last` range — nft syntax and the sidecar's `APPSTRATE_RUNNER_UIDS`. */
export const GUEST_RUNNER_UIDS = `${GUEST_RUNNER_UID_FIRST}-${GUEST_RUNNER_UID_FIRST + GUEST_RUNNER_UID_COUNT - 1}`;

/**
 * Firecracker MMDS link-local service address (matches the host-side
 * mmds-config in vm-config.ts). The credential broker serves the run's
 * secrets here; the supervisor fetches them at boot, then the firewall
 * drops all further access.
 */
export const MMDS_IPV4_ADDRESS = "169.254.169.254";

/**
 * The filter chain's policy is DROP with an explicit allowlist — a denylist
 * keyed on the agent uid alone would let any OTHER uid (root helpers, a
 * future user, a compromised process that changed uid) egress freely:
 *
 *   - loopback: always allowed (agent and runners ↔ sidecar ride 127.0.0.1).
 *   - root (supervisor): allowed — it is the trust anchor of the guest.
 *   - sidecar uid: full egress (it fronts the LLM proxy, the agent's forward
 *     proxy and every runner's egress listeners).
 *   - runner uid pool: loopback only, plus its redirected DNS (below). A
 *     runner's only exits are the sidecar's per-runner listeners, which
 *     enforce its egress allowlist; proxy-unaware clients reach them through
 *     the sidecar's transparent plane (DNS answered with 127.0.0.1, SNI/Host
 *     splicers on 127.0.0.1:443/:80).
 *   - agent uid: the platform sink only (its sidecar is on loopback, above).
 *   - everything else — any uid, any socketless packet — is dropped.
 *
 * DNS: /etc/resolv.conf is shared with the sidecar, which needs real
 * resolvers, so the runners' lookups are steered per uid in the kernel
 * instead — the `output_nat` chain redirects the pool's UDP/53 to the
 * sidecar's responder on 127.0.0.1:53, which never forwards a query, so DNS
 * is no exfiltration channel. Runner TCP/53 is simply dropped. NAT runs
 * before the filter chain but the packet keeps the output interface it was
 * first routed to (eth0), so the redirected flow needs its own accept.
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
    // highest precedence (drops before the skuid-0/sidecar accepts below).
    // Unconditional: in config-drive mode MMDS is not even configured, so
    // this is a harmless belt-and-suspenders (the host forward chain also
    // drops 169.254/16).
    `    ip daddr ${MMDS_IPV4_ADDRESS} drop`,
    `    oifname "lo" accept`,
    `    meta skuid 0 accept`,
    `    meta skuid ${GUEST_SIDECAR_UID} accept`,
    `    meta skuid ${GUEST_RUNNER_UIDS} ip daddr 127.0.0.1 udp dport 53 accept`,
    `    meta skuid ${GUEST_AGENT_UID} ip daddr ${network.platform_ip} tcp dport ${network.platform_port} accept`,
    `  }`,
    `  chain output_nat {`,
    `    type nat hook output priority -100; policy accept;`,
    `    meta skuid ${GUEST_RUNNER_UIDS} udp dport 53 redirect to :53`,
    `  }`,
    `}`,
    ``,
  ].join("\n");
}
