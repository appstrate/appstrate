// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  buildNftScript,
  createTap,
  deleteTap,
  listTapDevices,
  setupHostNetwork,
  teardownHostNetwork,
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

const PARAMS = {
  subnetCidr: "10.231.0.0/16",
  aliasIp: "10.231.255.1",
  platformPort: 3000,
  egressDenyCidrs: ["169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
};

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

  it("drops guest egress to metadata + private ranges BEFORE the forward accept", () => {
    const deny = script.indexOf(
      `iifname "afc*" ip daddr { 169.254.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 } drop`,
    );
    const egress = script.indexOf(`iifname "afc*" accept`);
    expect(deny).toBeGreaterThan(-1);
    expect(deny).toBeLessThan(egress);
  });

  it("omits the deny rule when the list is empty (operator opt-out)", () => {
    const open = buildNftScript({ ...PARAMS, egressDenyCidrs: [] });
    expect(open).not.toContain("ip daddr {");
  });
});

describe("teardownHostNetwork", () => {
  it("destroys the nft table and removes the iptables FORWARD accepts", async () => {
    // -C probes succeed (rules present) → both deletes issued.
    const { exec, calls } = fakeExec();
    await teardownHostNetwork(exec);
    expect(calls.map((c) => c.cmd.join(" "))).toEqual([
      "nft destroy table ip appstrate_fc",
      "iptables -C FORWARD -i afc+ -j ACCEPT",
      "iptables -D FORWARD -i afc+ -j ACCEPT",
      "iptables -C FORWARD -o afc+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
      "iptables -D FORWARD -o afc+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
    ]);
  });

  it("skips deletes for rules that are already gone", async () => {
    const { exec, calls } = fakeExec((cmd) =>
      cmd[0] === "iptables" && cmd[1] === "-C" ? new Error("no match") : "",
    );
    await teardownHostNetwork(exec);
    const deletes = calls.filter((c) => c.cmd[0] === "iptables" && c.cmd[1] === "-D");
    expect(deletes).toEqual([]);
  });

  it("tolerates a host without iptables entirely", async () => {
    const { exec } = fakeExec((cmd) =>
      cmd[0] === "iptables" ? new Error("iptables: command not found") : "",
    );
    await expect(teardownHostNetwork(exec)).resolves.toBeUndefined();
  });
});

describe("setupHostNetwork", () => {
  it("binds the alias, enables forwarding, applies the firewall atomically", async () => {
    const { exec, calls } = fakeExec();
    await setupHostNetwork(exec, PARAMS);
    expect(calls.slice(0, 4).map((c) => c.cmd.join(" "))).toEqual([
      "ip addr replace 10.231.255.1/32 dev lo",
      "sysctl -qw net.ipv4.ip_forward=1",
      "sysctl -qw net.ipv4.conf.all.rp_filter=2",
      "nft -f -",
    ]);
    expect(calls[3]?.stdin).toBe(buildNftScript(PARAMS));
  });

  it("whitelists TAP forwarding in the iptables pipeline (Docker coexistence)", async () => {
    // -C probes fail (rules absent) → both inserts issued.
    const { exec, calls } = fakeExec((cmd) =>
      cmd[0] === "iptables" && cmd[1] === "-C" ? new Error("no match") : "",
    );
    await setupHostNetwork(exec, PARAMS);
    const iptables = calls.filter((c) => c.cmd[0] === "iptables").map((c) => c.cmd.join(" "));
    expect(iptables).toEqual([
      "iptables -C FORWARD -i afc+ -j ACCEPT",
      "iptables -I FORWARD -i afc+ -j ACCEPT",
      "iptables -C FORWARD -o afc+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
      "iptables -I FORWARD -o afc+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
    ]);
  });

  it("skips inserts when the rules already exist", async () => {
    const { exec, calls } = fakeExec();
    await setupHostNetwork(exec, PARAMS);
    const inserts = calls.filter((c) => c.cmd[0] === "iptables" && c.cmd[1] === "-I");
    expect(inserts).toEqual([]);
  });

  it("tolerates a host without iptables entirely", async () => {
    const { exec } = fakeExec((cmd) =>
      cmd[0] === "iptables" ? new Error("iptables: command not found") : "",
    );
    await expect(setupHostNetwork(exec, PARAMS)).resolves.toBeUndefined();
  });
});

describe("createTap / deleteTap", () => {
  const subnet = subnetForIndex("10.231.0.0/16", 3);

  it("creates, addresses and brings up the device in ONE batched ip run", async () => {
    const { exec, calls } = fakeExec();
    await createTap(exec, subnet);
    expect(calls.map((c) => c.cmd.join(" "))).toEqual(["ip -batch -"]);
    expect(calls[0]?.stdin).toBe(
      "tuntap add dev afc3 mode tap\naddr add 10.231.0.13/30 dev afc3\nlink set dev afc3 up\n",
    );
  });

  it("reclaims a half-created TAP when the batch fails", async () => {
    const { exec, calls } = fakeExec((cmd) => (cmd[1] === "-batch" ? new Error("boom") : ""));
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
