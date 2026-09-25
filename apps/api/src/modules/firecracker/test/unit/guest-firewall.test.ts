// SPDX-License-Identifier: Apache-2.0

/**
 * The in-guest nftables script the supervisor applies before any workload
 * starts. The agent uid reaches loopback (its sidecar, via the `lo` rule) and
 * the platform sink, nothing else; the whole rule list is pinned so a new
 * accept is a visible change.
 */

import { describe, it, expect } from "bun:test";
import { buildGuestFirewallScript } from "../../guest/firewall.ts";

const NETWORK = { platform_ip: "10.231.255.1", platform_port: 3000 };

const rules = (script: string) =>
  script
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith("accept") || line.endsWith("drop"));

describe("buildGuestFirewallScript", () => {
  it("defaults to drop", () => {
    expect(buildGuestFirewallScript(NETWORK)).toContain("policy drop;");
  });

  it("pins the complete rule list", () => {
    expect(rules(buildGuestFirewallScript(NETWORK))).toEqual([
      "ip daddr 169.254.169.254 drop",
      'oifname "lo" accept',
      "meta skuid 0 accept",
      "meta skuid 1000 accept",
      "meta skuid 1002 accept",
      "meta skuid 1001 ip daddr 10.231.255.1 tcp dport 3000 accept",
    ]);
  });
});
