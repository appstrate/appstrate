// SPDX-License-Identifier: Apache-2.0

/**
 * The in-guest nftables script the supervisor applies before any workload
 * starts. The agent uid reaches loopback (its sidecar, via the `lo` rule) and
 * the platform sink; a runner uid reaches loopback and its DNS, redirected to
 * the sidecar's responder. The whole ruleset is pinned so a new accept or
 * NAT rule is a visible change.
 */

import { describe, it, expect } from "bun:test";
import { buildGuestFirewallScript, GUEST_RUNNER_UIDS } from "../../guest/firewall.ts";

const NETWORK = { platform_ip: "10.231.255.1", platform_port: 3000 };

describe("buildGuestFirewallScript", () => {
  it("pins the complete ruleset", () => {
    expect(buildGuestFirewallScript(NETWORK)).toBe(
      [
        "table inet appstrate_guest {",
        "  chain output {",
        "    type filter hook output priority filter; policy drop;",
        "    ip daddr 169.254.169.254 drop",
        '    oifname "lo" accept',
        "    meta skuid 0 accept",
        "    meta skuid 1000 accept",
        "    meta skuid 1100-1163 ip daddr 127.0.0.1 udp dport 53 accept",
        "    meta skuid 1001 ip daddr 10.231.255.1 tcp dport 3000 accept",
        "  }",
        "  chain output_nat {",
        "    type nat hook output priority -100; policy accept;",
        "    meta skuid 1100-1163 udp dport 53 redirect to :53",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("leaves the runner pool no exit but loopback and its redirected DNS", () => {
    // Every accept a runner packet can match: uid-agnostic ones + the pool's own.
    const pool = `meta skuid ${GUEST_RUNNER_UIDS} `;
    const runnerAccepts = buildGuestFirewallScript(NETWORK)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.endsWith(" accept"))
      .filter((line) => !line.includes("meta skuid") || line.startsWith(pool));
    expect(runnerAccepts).toEqual([
      'oifname "lo" accept',
      `${pool}ip daddr 127.0.0.1 udp dport 53 accept`,
    ]);
  });
});
