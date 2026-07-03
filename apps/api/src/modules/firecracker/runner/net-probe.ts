// SPDX-License-Identifier: Apache-2.0

/**
 * Self-verified guest→platform networking (issue #819, phase 5).
 *
 * The incident this exists to prevent: guest→platform sink traffic was
 * silently dropped by the daemon's own nft table because Docker's DNAT
 * rewrote the destination BEFORE the forward hook ran, so a plain
 * `ip daddr` match missed and the RFC1918 deny killed the packet. Three
 * hours of manual tcpdump to find. The `ct original` fix lives in
 * host-net.ts; this probe turns that whole class of failure into a
 * one-line boot diagnostic.
 *
 * The probe reproduces a real run's L3 path WITHOUT a microVM: an
 * ephemeral network namespace + a veth pair whose HOST end carries the
 * TAP naming prefix (`afc*`), so the very same `iifname "afc*"` nft rules
 * that gate guest traffic apply to it. It addresses the netns inside the
 * guest /30 and, from inside the netns, HTTP-GETs the platform URL. If
 * that succeeds the guest path is proven; if it fails while the host
 * itself CAN reach the platform, the nft/DNAT policy is the culprit and
 * we dump exactly what an operator needs (the ruleset, Docker's DNAT
 * table, the firewall commands) instead of leaving them to tcpdump.
 *
 * Every host command flows through the injectable {@link HostExec} seam,
 * so the whole sequence is unit-testable without CAP_NET_ADMIN.
 */

import { getErrorMessage } from "@appstrate/core/errors";
import type { HostExec } from "../host-net.ts";
import { subnetForIndex, TAP_DEVICE_PREFIX } from "../subnet.ts";
import { logger as defaultLogger } from "./logger.ts";

/** Minimal logger shape — matches the runner/platform pino logger call sites. */
export interface ProbeLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/**
 * Host-side veth end name. Carries the `afc*` prefix so the nft
 * `iifname "afc*"` rules fire on its traffic exactly like a real TAP —
 * but with a NON-numeric suffix, so the orphan sweep (which matches
 * `afc<digits>`) never reaps it and a real subnet allocation never
 * collides with it.
 */
const PROBE_HOST_IF = `${TAP_DEVICE_PREFIX}probe0`;
/** Peer end — moved into the netns immediately, so its root-ns name is transient. */
const PROBE_PEER_IF = `${TAP_DEVICE_PREFIX}probe0p`;
/** Ephemeral namespace name. */
const PROBE_NETNS = "appstrate-fc-probe";
/**
 * Reuse the first allocatable /30's arithmetic for the probe's addresses.
 * The probe runs at boot BEFORE the daemon accepts any run, so no live
 * subnet can be in use — index 1's block is free by construction.
 */
const PROBE_SUBNET_INDEX = 1;

/** Default budget for both the host and the in-netns HTTP GET. */
const DEFAULT_PROBE_TIMEOUT_MS = 4_000;

export interface GuestPathResult {
  /** Host process itself can reach the platform URL. */
  platformReachable: boolean;
  /**
   * Guest-path proven end-to-end through the nft policy.
   * `null` = the probe was skipped or could not run to a conclusion
   * (netns/curl tooling absent, or the platform itself is down so the
   * path could not be isolated).
   */
  guestPathVerified: boolean | null;
}

export interface VerifyGuestPathDeps {
  exec: HostExec;
  /** Guest-visible platform base URL (FIRECRACKER_RUNNER_PLATFORM_URL). */
  platformUrl: string;
  /** FIRECRACKER_SUBNET_CIDR — the /16 the probe carves its /30 from. */
  subnetCidr: string;
  /**
   * `strict` → a proven guest-path FAILURE is fatal (caller exits);
   * `warn` (default) → loud warning, boot continues. A degraded/
   * indeterminate result is never fatal — an unproven path is not a
   * proven failure.
   */
  mode?: "warn" | "strict";
  /** Injected in tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
  logger?: ProbeLogger;
  timeoutMs?: number;
}

/** `http://<host>:<port>` → `{ ip, port }` for DNAT-comparison diagnostics. */
function parseHostPort(url: string): { ip: string; port: number } | undefined {
  try {
    const u = new URL(url);
    const port = u.port !== "" ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    return { ip: u.hostname, port };
  } catch {
    return undefined;
  }
}

/** Cheap host→platform reachability check (no netns). */
async function hostCanReach(
  url: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<boolean> {
  try {
    // Any HTTP response (even 404/500) proves reachability — we test the
    // path, not what the app returns. Only a connect/timeout error means
    // unreachable.
    await fetchFn(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/** Are `ip netns` and `curl` both usable on this host? */
async function toolingAvailable(exec: HostExec): Promise<{ ok: boolean; missing?: string }> {
  try {
    await exec.run(["ip", "netns", "list"]);
  } catch {
    return { ok: false, missing: "ip netns (iproute2 netns support)" };
  }
  try {
    await exec.run(["curl", "--version"]);
  } catch {
    return { ok: false, missing: "curl" };
  }
  return { ok: true };
}

/** Bring up the netns + veth pair addressed inside the guest /30. */
async function setupProbeNetns(exec: HostExec, hostIp: string, guestIp: string): Promise<void> {
  // A crashed probe can leave the namespace (or host veth) behind; the
  // matching `add` below then fails with EEXIST, which strict mode would
  // surface as a false FATAL. Clear both first (ignore "not found").
  await exec.run(["ip", "netns", "del", PROBE_NETNS]).catch(() => {});
  await exec.run(["ip", "link", "del", PROBE_HOST_IF]).catch(() => {});
  await exec.run(["ip", "netns", "add", PROBE_NETNS]);
  await exec.run([
    "ip",
    "link",
    "add",
    PROBE_HOST_IF,
    "type",
    "veth",
    "peer",
    "name",
    PROBE_PEER_IF,
  ]);
  await exec.run(["ip", "link", "set", PROBE_PEER_IF, "netns", PROBE_NETNS]);
  await exec.run(["ip", "addr", "add", `${hostIp}/30`, "dev", PROBE_HOST_IF]);
  await exec.run(["ip", "link", "set", PROBE_HOST_IF, "up"]);
  // Match a real TAP's strict reverse-path posture — legitimate traffic
  // (the /30-connected guest source) always passes.
  await exec.run(["sysctl", "-qw", `net.ipv4.conf.${PROBE_HOST_IF}.rp_filter=1`]);
  await exec.run(["ip", "-n", PROBE_NETNS, "addr", "add", `${guestIp}/30`, "dev", PROBE_PEER_IF]);
  await exec.run(["ip", "-n", PROBE_NETNS, "link", "set", PROBE_PEER_IF, "up"]);
  await exec.run(["ip", "-n", PROBE_NETNS, "link", "set", "lo", "up"]);
  await exec.run(["ip", "-n", PROBE_NETNS, "route", "add", "default", "via", hostIp]);
}

/** Best-effort teardown — every step tolerates an already-gone resource. */
async function teardownProbeNetns(exec: HostExec): Promise<void> {
  // Deleting the netns destroys the peer, which destroys the whole veth;
  // the explicit link del is belt-and-braces for a half-created pair.
  await exec.run(["ip", "netns", "del", PROBE_NETNS]).catch(() => {});
  await exec.run(["ip", "link", "del", PROBE_HOST_IF]).catch(() => {});
}

/**
 * Dump the exact state an operator needs when the guest path is dropped
 * despite the host reaching the platform — the DNAT-bug signature.
 */
async function logDropDiagnostics(
  exec: HostExec,
  logger: ProbeLogger,
  platformUrl: string,
  level: "warn" | "error",
): Promise<void> {
  const target = parseHostPort(platformUrl);
  const ruleset = await exec
    .run(["nft", "list", "table", "ip", "appstrate_fc"])
    .catch((err) => `<unavailable: ${getErrorMessage(err)}>`);
  const dockerDnat = await exec
    .run(["iptables", "-t", "nat", "-S", "DOCKER"])
    .catch(() => "<no iptables DOCKER chain — platform is not a docker-published port here>");
  const platformIsDnat =
    target !== undefined &&
    dockerDnat.includes("--to-destination") &&
    dockerDnat.includes(String(target.port));

  const ufw = await exec.run(["ufw", "status"]).catch(() => "");
  const firewalld = await exec.run(["firewall-cmd", "--state"]).catch(() => "");
  const firewallHints: string[] = [];
  if (ufw.toLowerCase().includes("active")) {
    firewallHints.push(
      `ufw route allow in on ${TAP_DEVICE_PREFIX}+ out on any`,
      `ufw allow in on ${TAP_DEVICE_PREFIX}+`,
    );
  }
  if (firewalld.trim() === "running") {
    firewallHints.push(
      `firewall-cmd --permanent --zone=trusted --add-interface=${TAP_DEVICE_PREFIX}0`,
      `firewall-cmd --reload`,
    );
  }

  const hint = [
    `The host can reach ${platformUrl} but the GUEST path through the nft policy cannot — this is the DNAT drop signature.`,
    platformIsDnat
      ? `The platform endpoint IS a Docker-published port: Docker's DNAT (nat/PREROUTING) rewrites the destination before the forward hook, so the forward accept MUST match the conntrack ORIGINAL tuple (\`ct original\`), NOT a plain \`ip daddr\`. Check host-net.ts buildNftScript for a reverted rule.`
      : `Confirm the forward-chain accept for the platform endpoint precedes the RFC1918/egress deny in table ip appstrate_fc.`,
    firewallHints.length > 0
      ? `A host firewall is active — likely needed:\n  ${firewallHints.join("\n  ")}`
      : `No ufw/firewalld detected — the drop is inside table ip appstrate_fc, not a host firewall.`,
  ].join(" ");

  logger[level]("guest→platform path verification FAILED", {
    platformUrl,
    platformEndpoint: target ? `${target.ip}:${target.port}` : platformUrl,
    platformIsDockerDnat: platformIsDnat,
    nftRuleset: ruleset,
    dockerDnat,
    hint,
  });
}

/**
 * Verify the guest→platform network path end-to-end at daemon boot.
 * Never throws — the caller inspects the result and decides (per `mode`)
 * whether a proven failure is fatal. Diagnostics are logged here.
 */
export async function verifyGuestPath(deps: VerifyGuestPathDeps): Promise<GuestPathResult> {
  const {
    exec,
    platformUrl,
    subnetCidr,
    mode = "warn",
    fetchFn = globalThis.fetch,
    logger = defaultLogger,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  } = deps;

  const platformReachable = await hostCanReach(platformUrl, fetchFn, timeoutMs);

  const tooling = await toolingAvailable(exec);
  if (!tooling.ok) {
    logger.warn(
      "guest path NOT verified — netns probe tooling unavailable, falling back to a host-only reachability check",
      { missing: tooling.missing, platformReachable, platformUrl },
    );
    return { platformReachable, guestPathVerified: null };
  }

  const subnet = subnetForIndex(subnetCidr, PROBE_SUBNET_INDEX);
  let curlOk = false;
  try {
    await setupProbeNetns(exec, subnet.hostIp, subnet.guestIp);
    const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
    // curl exits 0 for ANY HTTP response (even 404) — reaching the
    // platform at all is what proves the path. A connect/timeout failure
    // throws (non-zero exit) and is caught below.
    await exec.run([
      "ip",
      "netns",
      "exec",
      PROBE_NETNS,
      "curl",
      "-sS",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "--max-time",
      String(timeoutSec),
      platformUrl,
    ]);
    curlOk = true;
  } catch (err) {
    logger.warn("guest path probe: in-netns request did not complete", {
      error: getErrorMessage(err),
    });
  } finally {
    await teardownProbeNetns(exec);
  }

  if (curlOk) {
    logger.info("guest→platform path verified", { platformUrl });
    return { platformReachable, guestPathVerified: true };
  }

  // Guest could not reach the platform. Disambiguate: if the HOST can't
  // reach it either, the platform is simply down — the path is
  // indeterminate (null), not proven-broken. Only a host-reachable-but-
  // guest-blocked result is the nft/DNAT drop we alarm on.
  if (!platformReachable) {
    logger.warn(
      "guest path NOT verified — the platform is unreachable from the host too; start the platform / check FIRECRACKER_RUNNER_PLATFORM_URL",
      { platformUrl },
    );
    return { platformReachable, guestPathVerified: null };
  }

  await logDropDiagnostics(exec, logger, platformUrl, mode === "strict" ? "error" : "warn");
  return { platformReachable, guestPathVerified: false };
}
