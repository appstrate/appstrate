// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";

import { buildGuestFirewallScript } from "../../guest/supervisor.ts";
import { buildGuestConfig } from "../../vm-config.ts";

function config(agentUnrestrictedEgress = false) {
  return buildGuestConfig({
    runId: "run_browser",
    exitMarkerNonce: "nonce",
    platformIp: "10.231.255.1",
    platformPort: 3000,
    sidecarEnv: { RUN_TOKEN: "secret" },
    agentEnv: {},
    agentUnrestrictedEgress,
    credentialSource: "inline",
  });
}

describe("Firecracker guest browser isolation policy", () => {
  it("gives each driver/browser UID pair only its matching reserved port", () => {
    const rules = buildGuestFirewallScript(config());
    expect(rules).toContain('meta skuid 1100 oifname "lo" tcp dport 18081 accept');
    expect(rules).toContain('meta skuid 1101 oifname "lo" tcp dport 18080 accept');
    expect(rules).toContain('meta skuid 1102 oifname "lo" tcp dport 18083 accept');
    expect(rules).toContain('meta skuid 1103 oifname "lo" tcp dport 18082 accept');
    expect(rules).toContain('meta skuid 1106 oifname "lo" tcp dport 18087 accept');
    expect(rules).toContain('meta skuid 1107 oifname "lo" tcp dport 18086 accept');
  });

  it("blocks reserved browser ports before legacy runner egress and narrows agent loopback", () => {
    const rules = buildGuestFirewallScript(config());
    const runnerDrop = rules.indexOf('meta skuid 1002 oifname "lo" tcp dport');
    const runnerAccept = rules.indexOf("meta skuid 1002 accept");
    expect(runnerDrop).toBeGreaterThan(0);
    expect(runnerDrop).toBeLessThan(runnerAccept);
    expect(rules).toContain("meta skuid 1001 ip daddr 127.0.0.1 tcp dport { 8080, 8081 } accept");
    expect(rules.split("\n").some((line) => line.trim() === 'oifname "lo" accept')).toBe(false);
  });

  it("leaves no external accept rule for any browser-specific UID", () => {
    const rules = buildGuestFirewallScript(config());
    for (const uid of [1100, 1101, 1102, 1103, 1104, 1105, 1106, 1107]) {
      expect(rules).not.toContain(`meta skuid ${uid} accept`);
    }
  });

  it("keeps reserved browser ports closed to an unrestricted agent", () => {
    const rules = buildGuestFirewallScript(config(true));
    const agentDrop = rules.indexOf('meta skuid 1001 oifname "lo" tcp dport');
    const agentAccept = rules.indexOf("meta skuid 1001 accept");
    expect(agentDrop).toBeGreaterThan(0);
    expect(agentDrop).toBeLessThan(agentAccept);
  });
});
