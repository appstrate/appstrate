// SPDX-License-Identifier: Apache-2.0

/**
 * Host-side network plumbing for the Firecracker orchestrator: per-run
 * TAP devices, the platform loopback alias, and the nftables policy
 * table. All mutations shell out to `ip`/`nft`/`sysctl` through an
 * injectable executor so the command surface is unit-testable without
 * CAP_NET_ADMIN.
 *
 * Host firewall policy (table `appstrate_fc`):
 *   - guests may reach the platform API at exactly `<alias>:<port>`
 *   - any other guest→host-local traffic is dropped (a guest must never
 *     see host-local services like Redis or the Docker socket proxy)
 *   - guest→internet is forwarded + masqueraded (the in-guest uid rules
 *     restrict WHICH process gets to use that egress)
 *   - guest→guest is dropped (per-run isolation)
 */

import type { RunSubnet } from "./subnet.ts";
import { TAP_DEVICE_PREFIX } from "./subnet.ts";

export interface HostExec {
  /** Run a host command; throws with stderr context on non-zero exit. */
  run(cmd: string[], opts?: { stdin?: string }): Promise<string>;
}

/** Production executor — Bun.spawn, `sudo -n` prefixed when not root. */
export function createHostExec(): HostExec {
  return {
    async run(cmd: string[], opts?: { stdin?: string }): Promise<string> {
      const argv = process.getuid?.() === 0 ? cmd : ["sudo", "-n", ...cmd];
      const proc = Bun.spawn(argv, {
        stdin: opts?.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : undefined,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      if (code !== 0) {
        throw new Error(`Host command failed (${code}): ${cmd.join(" ")} — ${stderr.trim()}`);
      }
      return stdout;
    },
  };
}

/**
 * Complete nftables policy, applied atomically via `nft -f -`. The
 * leading `destroy table` makes re-application idempotent (fresh boot,
 * crash recovery, config change) without touching other tables.
 */
export function buildNftScript(params: {
  subnetCidr: string;
  aliasIp: string;
  platformPort: number;
}): string {
  const { subnetCidr, aliasIp, platformPort } = params;
  const tap = `"${TAP_DEVICE_PREFIX}*"`;
  return [
    `destroy table ip appstrate_fc`,
    `table ip appstrate_fc {`,
    `  chain input {`,
    `    type filter hook input priority filter; policy accept;`,
    `    iifname ${tap} ip daddr ${aliasIp} tcp dport ${platformPort} accept`,
    `    iifname ${tap} drop`,
    `  }`,
    `  chain forward {`,
    `    type filter hook forward priority filter; policy accept;`,
    `    iifname ${tap} oifname ${tap} drop`,
    `    iifname ${tap} accept`,
    `    oifname ${tap} ct state established,related accept`,
    `    oifname ${tap} drop`,
    `  }`,
    `  chain postrouting {`,
    `    type nat hook postrouting priority srcnat; policy accept;`,
    `    ip saddr ${subnetCidr} oifname != ${tap} masquerade`,
    `  }`,
    `}`,
    ``,
  ].join("\n");
}

/** One-shot host prerequisites: alias IP, IPv4 forwarding, firewall table. */
export async function setupHostNetwork(
  exec: HostExec,
  params: { subnetCidr: string; aliasIp: string; platformPort: number },
): Promise<void> {
  // `replace` (not `add`) → idempotent across restarts.
  await exec.run(["ip", "addr", "replace", `${params.aliasIp}/32`, "dev", "lo"]);
  await exec.run(["sysctl", "-qw", "net.ipv4.ip_forward=1"]);
  // Loose reverse-path filtering: replies to the loopback alias leave
  // through TAP devices whose subnet differs from the alias — strict rp
  // filtering would drop the guests' platform traffic.
  await exec.run(["sysctl", "-qw", "net.ipv4.conf.all.rp_filter=2"]);
  await exec.run(["nft", "-f", "-"], { stdin: buildNftScript(params) });
}

/** Remove the policy table (leaves the harmless lo alias in place). */
export async function teardownHostNetwork(exec: HostExec): Promise<void> {
  await exec.run(["nft", "destroy", "table", "ip", "appstrate_fc"]).catch(() => {});
}

/** Create + bring up one run's TAP device. */
export async function createTap(exec: HostExec, subnet: RunSubnet): Promise<void> {
  await exec.run(["ip", "tuntap", "add", "dev", subnet.tapDevice, "mode", "tap"]);
  try {
    await exec.run(["ip", "addr", "add", `${subnet.hostIp}/30`, "dev", subnet.tapDevice]);
    await exec.run(["ip", "link", "set", "dev", subnet.tapDevice, "up"]);
  } catch (err) {
    // Half-created TAP would leak until the next boot sweep — reclaim now.
    await deleteTap(exec, subnet.tapDevice).catch(() => {});
    throw err;
  }
}

export async function deleteTap(exec: HostExec, tapDevice: string): Promise<void> {
  await exec.run(["ip", "link", "del", tapDevice]);
}

/** List existing `afc*` TAP devices (orphan sweep). */
export async function listTapDevices(exec: HostExec): Promise<string[]> {
  const out = await exec.run(["ip", "-j", "link", "show"]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const names: string[] = [];
  for (const entry of parsed) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "ifname" in entry &&
      typeof (entry as { ifname: unknown }).ifname === "string"
    ) {
      const name = (entry as { ifname: string }).ifname;
      if (
        name.startsWith(TAP_DEVICE_PREFIX) &&
        /^\d+$/.test(name.slice(TAP_DEVICE_PREFIX.length))
      ) {
        names.push(name);
      }
    }
  }
  return names;
}
