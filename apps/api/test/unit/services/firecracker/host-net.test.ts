// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  buildNftScript,
  createTap,
  deleteTap,
  listTapDevices,
  setupHostNetwork,
  type HostExec,
} from "../../../../src/services/orchestrator/firecracker/host-net.ts";
import { subnetForIndex } from "../../../../src/services/orchestrator/firecracker/subnet.ts";

interface RecordedCall {
  cmd: string[];
  stdin?: string;
}

function fakeExec(respond: (cmd: string[]) => string | Error = () => ""): {
  exec: HostExec;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    exec: {
      async run(cmd, opts) {
        calls.push({ cmd, ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}) });
        const result = respond(cmd);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

const PARAMS = { subnetCidr: "10.231.0.0/16", aliasIp: "10.231.255.1", platformPort: 3000 };

describe("buildNftScript", () => {
  const script = buildNftScript(PARAMS);

  it("is idempotent (destroys the table before recreating it)", () => {
    expect(script.startsWith("destroy table ip appstrate_fc")).toBe(true);
  });

  it("allows guests to reach ONLY the platform endpoint on the host", () => {
    const inputIdx = script.indexOf("chain input");
    const accept = script.indexOf(`ip daddr 10.231.255.1 tcp dport 3000 accept`);
    const drop = script.indexOf(`iifname "afc*" drop`);
    expect(accept).toBeGreaterThan(inputIdx);
    // The accept must precede the catch-all drop.
    expect(drop).toBeGreaterThan(accept);
  });

  it("blocks guest↔guest traffic before allowing egress forwarding", () => {
    const interVm = script.indexOf(`iifname "afc*" oifname "afc*" drop`);
    const egress = script.indexOf(`iifname "afc*" accept`);
    expect(interVm).toBeGreaterThan(-1);
    expect(egress).toBeGreaterThan(interVm);
  });

  it("masquerades the run subnets on the way out", () => {
    expect(script).toContain(`ip saddr 10.231.0.0/16 oifname != "afc*" masquerade`);
  });
});

describe("setupHostNetwork", () => {
  it("binds the alias, enables forwarding, applies the firewall atomically", async () => {
    const { exec, calls } = fakeExec();
    await setupHostNetwork(exec, PARAMS);
    expect(calls.map((c) => c.cmd.join(" "))).toEqual([
      "ip addr replace 10.231.255.1/32 dev lo",
      "sysctl -qw net.ipv4.ip_forward=1",
      "sysctl -qw net.ipv4.conf.all.rp_filter=2",
      "nft -f -",
    ]);
    expect(calls[3]?.stdin).toBe(buildNftScript(PARAMS));
  });
});

describe("createTap / deleteTap", () => {
  const subnet = subnetForIndex("10.231.0.0/16", 3);

  it("creates, addresses and brings up the device", async () => {
    const { exec, calls } = fakeExec();
    await createTap(exec, subnet);
    expect(calls.map((c) => c.cmd.join(" "))).toEqual([
      "ip tuntap add dev afc3 mode tap",
      "ip addr add 10.231.0.13/30 dev afc3",
      "ip link set dev afc3 up",
    ]);
  });

  it("reclaims a half-created TAP when addressing fails", async () => {
    const { exec, calls } = fakeExec((cmd) =>
      cmd.join(" ").startsWith("ip addr add") ? new Error("boom") : "",
    );
    await expect(createTap(exec, subnet)).rejects.toThrow("boom");
    expect(calls.at(-1)?.cmd.join(" ")).toBe("ip link del afc3");
  });

  it("delete is a single link del", async () => {
    const { exec, calls } = fakeExec();
    await deleteTap(exec, "afc3");
    expect(calls.map((c) => c.cmd.join(" "))).toEqual(["ip link del afc3"]);
  });
});

describe("listTapDevices", () => {
  it("returns only appstrate TAP devices", async () => {
    const links = JSON.stringify([
      { ifname: "lo" },
      { ifname: "afc1" },
      { ifname: "afc22" },
      { ifname: "afcx" }, // prefix but not an index → not ours
      { ifname: "docker0" },
    ]);
    const { exec } = fakeExec(() => links);
    expect(await listTapDevices(exec)).toEqual(["afc1", "afc22"]);
  });

  it("tolerates unparseable output", async () => {
    const { exec } = fakeExec(() => "not-json");
    expect(await listTapDevices(exec)).toEqual([]);
  });
});
