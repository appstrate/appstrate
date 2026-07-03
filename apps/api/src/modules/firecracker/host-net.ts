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
 *   - guest egress to the deny CIDRs (cloud metadata, RFC1918) is dropped
 *     before the general forward accept — egress means INTERNET, never the
 *     host's private neighbourhood (FIRECRACKER_EGRESS_DENY_CIDRS)
 *   - guest→internet is forwarded + masqueraded (the in-guest uid rules
 *     restrict WHICH process gets to use that egress)
 *   - guest→guest is dropped (per-run isolation)
 */

import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "./runner/logger.ts";
import type { RunSubnet } from "./subnet.ts";
import { TAP_DEVICE_PREFIX } from "./subnet.ts";
import { spawnCollect } from "../../services/orchestrator/subprocess-util.ts";

export interface HostExec {
  /** Run a host command; throws with stderr context on non-zero exit. */
  run(cmd: string[], opts?: { stdin?: string }): Promise<string>;
}

/** Production executor — Bun.spawn, `sudo -n` prefixed when not root. */
export function createHostExec(): HostExec {
  return {
    async run(cmd: string[], opts?: { stdin?: string }): Promise<string> {
      const argv = process.getuid?.() === 0 ? cmd : ["sudo", "-n", ...cmd];
      // The error reports the unprefixed command — the sudo wrapper is an
      // executor detail, not part of what the caller asked to run.
      const { exitCode, stdout, stderr } = await spawnCollect(argv, { stdin: opts?.stdin });
      if (exitCode !== 0) {
        throw new Error(`Host command failed (${exitCode}): ${cmd.join(" ")} — ${stderr.trim()}`);
      }
      return stdout;
    },
  };
}

/**
 * Complete nftables policy, applied atomically via `nft -f -`. The
 * leading `add table` + `delete table` pair makes re-application
 * idempotent (fresh boot, crash recovery, config change) without
 * touching other tables. NOT `destroy table`: that verb needs
 * nftables >= 1.0.8 AND host kernel >= 6.3, which rules out Debian 12
 * and Ubuntu 22.04 — `add` (no-op when present) followed by `delete`
 * is the portable spelling of the same idempotency.
 */
export function buildNftScript(params: {
  subnetCidr: string;
  aliasIp: string;
  platformPort: number;
  /** Forward-path destinations guests may never reach (metadata, RFC1918). */
  egressDenyCidrs: string[];
  /**
   * REMOTE platform API endpoint (daemon topology: the platform is not
   * this process, e.g. a Docker container next to the appstrate-runner
   * daemon). Guests must reach exactly this ip:port unconditionally — it
   * typically sits inside the deny CIDRs (RFC1918 / docker bridge) and
   * the run's TAP may not even have egress, so the accept must beat
   * every drop, exactly like the lo-alias accept does when the platform
   * endpoint is the host lo alias. Absent = dev smoke-harness topology
   * (scripts/dev/smoke.ts serves its platform stub on the lo alias),
   * script unchanged.
   */
  platformForward?: { ip: string; port: number };
}): string {
  const { subnetCidr, aliasIp, platformPort, egressDenyCidrs, platformForward } = params;
  const tap = `"${TAP_DEVICE_PREFIX}*"`;
  const denySet = egressDenyCidrs.join(", ");
  // Whether guest→platform traffic is delivered locally (INPUT hook — the
  // host owns the platform IP, e.g. a docker bridge address) or routed
  // (FORWARD hook) depends on host topology we don't control. Emit the
  // accept in BOTH chains of this table — two one-line rules remove the
  // topology guesswork, and the unmatched copy is a harmless no-op. Both
  // copies precede the drops in their chain (a drop in ANY hooked table
  // is final, so the accept must win INSIDE this table). No teardown
  // mirror needed: both rules die with the table delete.
  // The forward copy matches the conntrack ORIGINAL tuple, not the packet
  // header: when the platform endpoint is a docker-published port on this
  // host, docker's DNAT (prerouting, dstnat priority) rewrites the
  // destination to the container ip:port BEFORE the forward hook runs, so a
  // plain `ip daddr` match never fires and the RFC1918 deny below kills the
  // sink traffic. `ct original` sees the pre-DNAT destination in both the
  // DNAT and the plain-routed case.
  const platformInputAccept = platformForward
    ? [`    iifname ${tap} ip daddr ${platformForward.ip} tcp dport ${platformForward.port} accept`]
    : [];
  const platformForwardAccept = platformForward
    ? [
        `    iifname ${tap} ct original ip daddr ${platformForward.ip} ct original proto-dst ${platformForward.port} accept`,
      ]
    : [];
  return [
    `add table ip appstrate_fc`,
    `delete table ip appstrate_fc`,
    `table ip appstrate_fc {`,
    `  chain input {`,
    `    type filter hook input priority filter; policy accept;`,
    `    iifname ${tap} ip daddr ${aliasIp} tcp dport ${platformPort} accept`,
    ...platformInputAccept,
    `    iifname ${tap} drop`,
    `  }`,
    `  chain forward {`,
    `    type filter hook forward priority filter; policy accept;`,
    `    iifname ${tap} oifname ${tap} drop`,
    ...platformForwardAccept,
    // The platform alias rides the input hook (it lives on lo), so this
    // deny never blocks sink/API traffic — only routed egress. The remote
    // platform accept above beats it by rule order.
    ...(denySet.length > 0 ? [`    iifname ${tap} ip daddr { ${denySet} } drop`] : []),
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
  params: {
    subnetCidr: string;
    aliasIp: string;
    platformPort: number;
    egressDenyCidrs: string[];
    /** Remote platform endpoint guests must always reach — see buildNftScript. */
    platformForward?: { ip: string; port: number };
  },
): Promise<void> {
  // `replace` (not `add`) → idempotent across restarts.
  await exec.run(["ip", "addr", "replace", `${params.aliasIp}/32`, "dev", "lo"]);
  await exec.run(["sysctl", "-qw", "net.ipv4.ip_forward=1"]);
  await exec.run(["nft", "-f", "-"], { stdin: buildNftScript(params) });
  await allowForwardInIptables(exec);
}

/**
 * Coexist with an iptables-managed FORWARD pipeline (Docker sets the
 * policy to DROP on any host running dockerd). nftables verdicts are
 * per-table: the `accept` in `appstrate_fc` does NOT exempt guest
 * egress from a drop in the iptables-owned `ip filter` table, so the
 * TAP traffic must be whitelisted there too. Guest↔guest isolation is
 * unaffected — `appstrate_fc` still drops it regardless of these
 * accepts (a drop in ANY hooked table is final).
 *
 * Best-effort by design: a host without the iptables binary has no
 * conflicting pipeline to coexist with, and `-C` probing keeps the
 * inserts idempotent across restarts.
 */
const IPTABLES_FORWARD_RULES: string[][] = [
  ["-i", `${TAP_DEVICE_PREFIX}+`, "-j", "ACCEPT"],
  [
    "-o",
    `${TAP_DEVICE_PREFIX}+`,
    "-m",
    "conntrack",
    "--ctstate",
    "ESTABLISHED,RELATED",
    "-j",
    "ACCEPT",
  ],
];

async function allowForwardInIptables(exec: HostExec): Promise<void> {
  for (const rule of IPTABLES_FORWARD_RULES) {
    try {
      await exec.run(["iptables", "-C", "FORWARD", ...rule]);
    } catch {
      // Still best-effort, but never silent: on a dockerd host (FORWARD
      // policy DROP — the exact pipeline this function coexists with) a
      // failed insert means guest egress is fully broken, and the only
      // symptom would be opaque in-run network timeouts. The likeliest
      // cause is a sudoers grant that covers ip/nft/sysctl but not
      // iptables (see FIRECRACKER.md "Requirements & privileges").
      await exec.run(["iptables", "-I", "FORWARD", ...rule]).catch((err) => {
        logger.warn(
          "Could not insert the iptables FORWARD accept for TAP traffic — " +
            "guest egress will be blocked on hosts where iptables owns FORWARD (e.g. dockerd)",
          { rule: rule.join(" "), error: getErrorMessage(err) },
        );
      });
    }
  }
}

/**
 * Remove the policy table and the iptables FORWARD accepts. The lo alias
 * and the sysctls are left in place — both are idempotent (`replace`/set)
 * and harmless without TAP devices. Best-effort: teardown runs on shutdown
 * paths where the rules may already be gone.
 */
export async function teardownHostNetwork(exec: HostExec): Promise<void> {
  // `delete` (not `destroy`, nftables >= 1.0.8 only) — absent-table
  // errors are swallowed like every other teardown step here.
  await exec.run(["nft", "delete", "table", "ip", "appstrate_fc"]).catch(() => {});
  for (const rule of IPTABLES_FORWARD_RULES) {
    try {
      await exec.run(["iptables", "-C", "FORWARD", ...rule]);
    } catch {
      continue; // Rule absent — nothing to remove.
    }
    await exec.run(["iptables", "-D", "FORWARD", ...rule]).catch(() => {});
  }
}

/**
 * Create + bring up one run's TAP device. One privileged spawn instead of
 * three: `ip -batch -` executes the add/addr/up sequence from stdin and
 * aborts at the first failing line (no `-force`).
 *
 * Strict reverse-path filtering on the TAP is the L3 anti-spoofing layer:
 * the kernel drops any guest packet whose source address does not route
 * back through this TAP, so a guest cannot emit traffic with another
 * guest's (or any foreign) source IP. Legitimate traffic always passes —
 * the guest's only valid source is its /30 address, which is directly
 * connected on this interface (this includes replies to the platform's
 * loopback alias). Effective rp_filter is max(conf.all, conf.<iface>), so
 * the per-interface strict setting holds regardless of the host default.
 */
export async function createTap(exec: HostExec, subnet: RunSubnet): Promise<void> {
  const batch =
    [
      `tuntap add dev ${subnet.tapDevice} mode tap`,
      `addr add ${subnet.hostIp}/30 dev ${subnet.tapDevice}`,
      `link set dev ${subnet.tapDevice} up`,
    ].join("\n") + "\n";
  try {
    await exec.run(["ip", "-batch", "-"], { stdin: batch });
    await exec.run(["sysctl", "-qw", `net.ipv4.conf.${subnet.tapDevice}.rp_filter=1`]);
  } catch (err) {
    // Half-created TAP would leak until the next boot sweep — reclaim now
    // (a no-op error when the batch failed on the very first line).
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
