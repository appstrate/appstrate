// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  buildNftScript,
  createTap,
  deleteTap,
  listTapDevices,
  setupHostNetwork,
  teardownHostNetwork,
} from "../../host-net.ts";
import { subnetForIndex } from "../../subnet.ts";
import { fakeHostExec as fakeExec } from "../helpers/fake-host-exec.ts";

const PARAMS = {
  subnetCidr: "10.231.0.0/16",
  aliasIp: "10.231.255.1",
  platformPort: 3000,
  egressDenyCidrs: ["169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
};

describe("buildNftScript", () => {
  const script = buildNftScript(PARAMS);

  it("is idempotent (add+delete pair — portable, unlike `destroy` which needs nft >= 1.0.8)", () => {
    expect(script.startsWith("add table ip appstrate_fc\ndelete table ip appstrate_fc")).toBe(true);
    expect(script).not.toContain("destroy table");
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

describe("buildNftScript with a jailed-VMM uid range (escaped-VMM output guard)", () => {
  const RANGE = { base: 200_000, hi: 200_016 };
  const script = buildNftScript({ ...PARAMS, vmmUidRange: RANGE });
  const guardRule =
    `meta skuid 200000-200016 ip daddr ` +
    `{ 169.254.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8 } drop`;

  it("emits an output-hook chain dropping VMM-uid traffic to the deny CIDRs plus loopback", () => {
    const chainIdx = script.indexOf("chain output");
    const ruleIdx = script.indexOf(guardRule);
    expect(chainIdx).toBeGreaterThan(-1);
    expect(script).toContain("type filter hook output priority filter; policy accept;");
    expect(ruleIdx).toBeGreaterThan(chainIdx);
  });

  it("always includes loopback exactly once, even when the deny list already carries it", () => {
    const withLo = buildNftScript({
      ...PARAMS,
      egressDenyCidrs: [...PARAMS.egressDenyCidrs, "127.0.0.0/8"],
      vmmUidRange: RANGE,
    });
    const outputChain = withLo.slice(withLo.indexOf("chain output"));
    expect(outputChain.split("127.0.0.0/8").length - 1).toBe(1);
  });

  it("still guards loopback when the operator empties the deny list", () => {
    const open = buildNftScript({ ...PARAMS, egressDenyCidrs: [], vmmUidRange: RANGE });
    expect(open).toContain("meta skuid 200000-200016 ip daddr { 127.0.0.0/8 } drop");
  });

  it("omits the chain entirely without a uid range (jailer off — VMM runs as the daemon uid)", () => {
    expect(buildNftScript(PARAMS)).not.toContain("chain output");
  });

  it("dies with the table (no separate teardown needed): the chain lives inside appstrate_fc", () => {
    // Structural: the output chain sits between the table's braces, so the
    // add+delete idempotency pair and teardownHostNetwork cover it.
    const tableOpen = script.indexOf("table ip appstrate_fc {");
    const tableClose = script.lastIndexOf("}");
    const chainIdx = script.indexOf("chain output");
    expect(chainIdx).toBeGreaterThan(tableOpen);
    expect(chainIdx).toBeLessThan(tableClose);
  });
});

describe("buildNftScript with a remote platform (platformForward)", () => {
  const FORWARD = { ip: "172.17.0.1", port: 3000 };
  const script = buildNftScript({ ...PARAMS, platformForward: FORWARD });
  const inputRule = `iifname "afc*" ip daddr 172.17.0.1 tcp dport 3000 accept`;
  // The forward copy matches the conntrack ORIGINAL tuple: when the platform
  // endpoint is a docker-published port on this host, docker's DNAT rewrites
  // the destination before the forward hook, so a plain `ip daddr` match
  // would never fire there.
  const forwardRule = `iifname "afc*" ct original ip daddr 172.17.0.1 ct original proto-dst 3000 accept`;

  it("accepts guest→platform in BOTH input and forward chains (topology-agnostic)", () => {
    const inputCopy = script.indexOf(inputRule);
    const forwardCopy = script.indexOf(forwardRule);
    expect(inputCopy).toBeGreaterThan(-1);
    expect(forwardCopy).toBeGreaterThan(inputCopy);
    expect(inputCopy).toBeGreaterThan(script.indexOf("chain input"));
    expect(forwardCopy).toBeGreaterThan(script.indexOf("chain forward"));
  });

  it("beats the guest→host catch-all drop (input) and the deny-CIDR drop (forward)", () => {
    const inputCopy = script.indexOf(inputRule);
    const forwardCopy = script.indexOf(forwardRule);
    // Input copy before the guest→host catch-all drop — platform
    // reachability is unconditional, like the lo-alias accept.
    expect(inputCopy).toBeLessThan(script.indexOf(`iifname "afc*" drop`));
    // Forward copy before the egress deny-CIDR drop: 172.17.0.1 is inside
    // 172.16.0.0/12, which would otherwise drop it (a drop in ANY hooked
    // table is final — the accept must win by order inside this one).
    expect(forwardCopy).toBeLessThan(script.indexOf("ip daddr {"));
  });

  it("stays byte-identical to the lo-alias-only script when platformForward is absent (dev smoke-harness topology)", () => {
    expect(buildNftScript(PARAMS)).toBe(
      [
        "add table ip appstrate_fc",
        "delete table ip appstrate_fc",
        "table ip appstrate_fc {",
        "  chain input {",
        "    type filter hook input priority filter; policy accept;",
        '    iifname "afc*" ip daddr 10.231.255.1 tcp dport 3000 accept',
        '    iifname "afc*" drop',
        "  }",
        "  chain forward {",
        "    type filter hook forward priority filter; policy accept;",
        '    iifname "afc*" oifname "afc*" drop',
        '    iifname "afc*" ip daddr { 169.254.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 } drop',
        '    iifname "afc*" accept',
        '    oifname "afc*" ct state established,related accept',
        '    oifname "afc*" drop',
        "  }",
        "  chain postrouting {",
        "    type nat hook postrouting priority srcnat; policy accept;",
        '    ip saddr 10.231.0.0/16 oifname != "afc*" masquerade',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("is applied by setupHostNetwork (pass-through to the atomic nft -f)", async () => {
    const { exec, calls } = fakeExec();
    await setupHostNetwork(exec, { ...PARAMS, platformForward: FORWARD });
    expect(calls[2]?.stdin).toBe(script);
  });
});

describe("teardownHostNetwork", () => {
  it("deletes the nft table and removes the iptables FORWARD accepts", async () => {
    // -C probes succeed (rules present) → both deletes issued.
    const { exec, calls } = fakeExec();
    await teardownHostNetwork(exec);
    expect(calls.map((c) => c.cmd.join(" "))).toEqual([
      "nft delete table ip appstrate_fc",
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
    expect(calls.slice(0, 3).map((c) => c.cmd.join(" "))).toEqual([
      "ip addr replace 10.231.255.1/32 dev lo",
      "sysctl -qw net.ipv4.ip_forward=1",
      "nft -f -",
    ]);
    expect(calls[2]?.stdin).toBe(buildNftScript(PARAMS));
  });

  it("never loosens rp_filter host-wide (anti-spoofing is per-TAP, strict)", async () => {
    const { exec, calls } = fakeExec();
    await setupHostNetwork(exec, PARAMS);
    expect(calls.some((c) => c.cmd.join(" ").includes("conf.all.rp_filter"))).toBe(false);
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

  it("creates, addresses and brings up the device in ONE batched ip run, then pins strict rp_filter", async () => {
    const { exec, calls } = fakeExec();
    await createTap(exec, subnet);
    expect(calls.map((c) => c.cmd.join(" "))).toEqual([
      "ip -batch -",
      // L3 anti-spoofing: the kernel drops guest packets whose source
      // doesn't route back through this TAP (another guest's IP, any
      // foreign IP).
      "sysctl -qw net.ipv4.conf.afc3.rp_filter=1",
    ]);
    expect(calls[0]?.stdin).toBe(
      "tuntap add dev afc3 mode tap\naddr add 10.231.0.13/30 dev afc3\nlink set dev afc3 up\n",
    );
  });

  it("creates the TAP owned by the jail uid when ownerUid is given (jailer mode)", async () => {
    // TUNSETIFF on an existing device needs CAP_NET_ADMIN unless the
    // caller matches the device owner — the jailed VMM (unprivileged
    // per-VM uid) can only attach to a TAP born as its own.
    const { exec, calls } = fakeExec();
    await createTap(exec, subnet, { ownerUid: 64_003 });
    expect(calls[0]?.stdin).toBe(
      "tuntap add dev afc3 mode tap user 64003\naddr add 10.231.0.13/30 dev afc3\nlink set dev afc3 up\n",
    );
  });

  it("reclaims a half-created TAP when the batch fails", async () => {
    const { exec, calls } = fakeExec((cmd) => (cmd[1] === "-batch" ? new Error("boom") : ""));
    await expect(createTap(exec, subnet)).rejects.toThrow("boom");
    expect(calls.at(-1)?.cmd.join(" ")).toBe("ip link del afc3");
  });

  it("reclaims the TAP when the rp_filter sysctl fails (anti-spoofing is mandatory)", async () => {
    const { exec, calls } = fakeExec((cmd) => (cmd[0] === "sysctl" ? new Error("denied") : ""));
    await expect(createTap(exec, subnet)).rejects.toThrow("denied");
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
