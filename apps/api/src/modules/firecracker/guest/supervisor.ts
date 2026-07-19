// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate Firecracker guest supervisor.
 *
 * Runs as root (inherits PID 1's privileges) inside the per-run microVM.
 * Responsibilities, in order:
 *
 *   1. Read the launch spec from the read-only config drive (/config).
 *   2. Apply the in-guest firewall that isolates the agent's egress from
 *      the sidecar's — the microVM-internal counterpart of the Docker
 *      credential-isolation boundary.
 *   3. Launch the sidecar (uid 1000) and the agent (uid 1001) as separate
 *      unprivileged users, so the agent cannot read the sidecar's
 *      environment (credentials) via /proc.
 *   4. Wait for the AGENT to exit — it is the run's primary workload. The
 *      sidecar is torn down alongside it.
 *   5. Print `APPSTRATE_EXIT:<code>` on the serial console (the host reads
 *      it back through `waitForExit`) and power the VM off.
 *
 * This mirrors, inside one VM, what the platform's Docker orchestrator
 * does with two containers on a bridge network — but the isolation
 * boundary the HOST cares about is the hardware VM around the whole run.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, chownSync, readFileSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
// Wire contract shared with the host-side producer (vm-config.ts's
// buildGuestConfig). Type-only: erased by `bun build`, so the supervisor
// bundle stays self-contained.
import type { GuestConfig } from "./guest-config.ts";

const GUEST_SIDECAR_UID = "1000";
const GUEST_AGENT_UID = "1001";
const GUEST_RUNNER_UID = "1002";
const BROWSER_DRIVER_UID_BASE = 1100;
const BROWSER_UID_BASE = 1101;
const BROWSER_SLOT_STRIDE = 2;
const BROWSER_MAX_SLOTS = 4;
const BROWSER_GATEWAY_PORT_BASE = 18_080;
const BROWSER_WORKER_PORT_BASE = 18_081;
const GUEST_AGENT_USER = "pi"; // uid 1001, baked into the rootfs
const SIDECAR_BIN = "/usr/local/bin/sidecar";
/** setuid(1002) wrapper the sidecar uses to spawn integration runners. */
const RUNNER_EXEC_WRAPPER = "/usr/local/bin/appstrate-runner-exec";
const BROWSER_EXEC_WRAPPER = "/usr/local/bin/appstrate-browser-exec";
const BROWSER_EXECUTABLE = "/usr/bin/chromium-browser";
const AGENT_ENTRY = "/runtime/dist/entrypoint.js";
const CONFIG_PATH = "/config/config.json";
/**
 * Pre-warmed Bun transpiler cache baked into the rootfs at image build (see
 * runtime-pi/Dockerfile). The guest page cache is empty on every boot
 * (VM-per-run), so skipping the re-parse of the bundled entrypoint + Pi SDK
 * is a direct cold-start win. Docker containers inherit this from the image
 * ENV; here the agent env comes from the config drive, so the supervisor
 * injects it. New entries written at runtime land in the tmpfs overlay.
 */
const TRANSPILER_CACHE_PATH = "/runtime/.transpiler-cache";

/**
 * Firecracker MMDS link-local service address (matches the host-side
 * mmds-config in vm-config.ts). The credential broker serves the run's
 * secrets here; the supervisor fetches them at boot, then applyFirewall
 * drops all further access.
 */
const MMDS_IPV4_ADDRESS = "169.254.169.254";

function log(msg: string): void {
  process.stdout.write(`[supervisor] ${msg}\n`);
}

/**
 * Fail-closed pre-launch abort: 126 is the supervisor's "refused to run
 * the workloads" code (vs 125 for a supervisor crash). Typed `never` so
 * callers get compile-time proof that control does not continue.
 */
function fatal(msg: string): never {
  log(`FATAL: ${msg}`);
  printExitMarker(126);
  powerOff();
}

function readConfig(): GuestConfig {
  const raw: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  if (typeof raw !== "object" || raw === null) {
    throw new Error("config.json is not an object");
  }
  return raw as GuestConfig;
}

/**
 * Guest egress firewall (nftables `inet` family), default-deny.
 *
 * The chain policy is DROP with an explicit allowlist — a denylist keyed
 * on the agent uid alone would let any OTHER uid (root helpers, a future
 * user, a compromised process that changed uid) egress freely:
 *
 *   - loopback: always allowed (agent ↔ sidecar traffic rides 127.0.0.1).
 *   - root (supervisor): allowed — it is the trust anchor of the guest.
 *   - sidecar uid: full egress (it fronts the LLM proxy + forward proxy).
 *   - runner uid: full egress (integration MCP servers call external APIs).
 *   - agent uid: loopback + the platform sink only, UNLESS the run is
 *     skipSidecar (then the agent needs direct upstream egress).
 *   - everything else — any uid, any socketless packet — is dropped.
 *
 * DNS to the configured resolvers is allowed for whoever has egress
 * (sidecar/runner always, agent only when unrestricted) via the general
 * accept rules — no special-casing needed.
 */
export function buildGuestFirewallScript(cfg: GuestConfig): string {
  const reservedBrowserPorts = Array.from({ length: BROWSER_MAX_SLOTS }, (_unused, slot) => [
    BROWSER_GATEWAY_PORT_BASE + slot * BROWSER_SLOT_STRIDE,
    BROWSER_WORKER_PORT_BASE + slot * BROWSER_SLOT_STRIDE,
  ]).flat();
  const reservedPortSet = `{ ${reservedBrowserPorts.join(", ")} }`;
  const browserIsolationRules = Array.from({ length: BROWSER_MAX_SLOTS }, (_unused, slot) => {
    const driverUid = BROWSER_DRIVER_UID_BASE + slot * BROWSER_SLOT_STRIDE;
    const browserUid = BROWSER_UID_BASE + slot * BROWSER_SLOT_STRIDE;
    const gatewayPort = BROWSER_GATEWAY_PORT_BASE + slot * BROWSER_SLOT_STRIDE;
    const workerPort = BROWSER_WORKER_PORT_BASE + slot * BROWSER_SLOT_STRIDE;
    return [
      // The driver can reach only its own authenticated control endpoint
      // among the reserved browser ports. Other loopback remains available
      // for its per-integration credential proxy and stdio-adjacent helpers.
      `    meta skuid ${driverUid} oifname "lo" tcp dport ${workerPort} accept`,
      `    meta skuid ${driverUid} oifname "lo" tcp dport ${reservedPortSet} drop`,
      `    meta skuid ${driverUid} oifname "lo" accept`,
      // Chromium and its broker share one uid and need arbitrary loopback
      // for DevTools + the auth shim, but only the matching gateway in the
      // fixed reserved range. There is deliberately no external accept.
      `    meta skuid ${browserUid} oifname "lo" tcp dport ${gatewayPort} accept`,
      `    meta skuid ${browserUid} oifname "lo" tcp dport ${reservedPortSet} drop`,
      `    meta skuid ${browserUid} oifname "lo" accept`,
    ];
  }).flat();
  const agentEgress = cfg.agent.unrestricted_egress
    ? [
        // Unrestricted means external egress; it never grants access to
        // privileged browser control/gateway listeners inside the guest.
        `      meta skuid ${GUEST_AGENT_UID} oifname "lo" tcp dport ${reservedPortSet} drop`,
        `      meta skuid ${GUEST_AGENT_UID} accept`,
      ]
    : [
        `      meta skuid ${GUEST_AGENT_UID} ip daddr 127.0.0.1 tcp dport { 8080, 8081 } accept`,
        `      meta skuid ${GUEST_AGENT_UID} ip daddr ${cfg.network.platform_ip} tcp dport ${cfg.network.platform_port} accept`,
      ];

  const script = [
    `table inet appstrate_guest {`,
    `  chain output {`,
    `    type filter hook output priority filter; policy drop;`,
    // Credential broker: by the time this firewall is applied the
    // supervisor has already fetched the run's secrets from MMDS. Slam the
    // link-local metadata address shut for EVERY uid — including root and
    // any unrestricted_egress agent — so no workload can ever read the
    // credential store back. First rule = highest precedence (drops before
    // the skuid-0/sidecar/runner accepts below). Unconditional: in
    // config-drive mode MMDS is not even configured, so this is a harmless
    // belt-and-suspenders (the host forward chain also drops 169.254/16).
    `    ip daddr ${MMDS_IPV4_ADDRESS} drop`,
    `    meta skuid 0 accept`,
    `    meta skuid ${GUEST_SIDECAR_UID} accept`,
    // Ordinary (non-browser) runners keep their legacy egress, but cannot
    // dial any browser worker/gateway even if they guess its loopback port.
    `    meta skuid ${GUEST_RUNNER_UID} oifname "lo" tcp dport ${reservedPortSet} drop`,
    `    meta skuid ${GUEST_RUNNER_UID} accept`,
    ...browserIsolationRules,
    ...agentEgress,
    `  }`,
    `}`,
    ``,
  ].join("\n");
  return script;
}

function applyFirewall(exec: RunHostCmd, cfg: GuestConfig): Promise<void> {
  return exec(["nft", "-f", "-"], buildGuestFirewallScript(cfg));
}

type RunHostCmd = (cmd: string[], stdin?: string) => Promise<void>;

/** Run a host command to completion; reject on non-zero exit. */
const runHostCmd: RunHostCmd = (cmd, stdin) =>
  new Promise((resolve, reject) => {
    const [bin, ...args] = cmd;
    if (!bin) {
      reject(new Error("empty command"));
      return;
    }
    const proc: ChildProcess = spawn(bin, args, { stdio: ["pipe", "inherit", "inherit"] });
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
    proc.on("error", reject);
    proc.on("exit", (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd.join(" ")} exited ${code}`));
    });
  });

interface Child {
  pid: number;
  exited: Promise<number>;
  kill: () => void;
}

/**
 * Launch a workload as an unprivileged user via `setpriv`, inheriting the
 * given env. `setpriv --reuid --regid --clear-groups` drops privileges
 * without a login shell (no PAM, no env scrubbing), so the caller's env
 * reaches the workload verbatim.
 *
 * `harden` additionally sets no_new_privs and empties the capability
 * bounding set — the agent must never regain privileges through a setuid
 * exec. The sidecar is NOT hardened: it legitimately execs the setuid
 * runner wrapper to drop its integration runners to uid 1002.
 */
function spawnAs(
  uidOrUser: string,
  argv: string[],
  env: Record<string, string>,
  cwd: string,
  opts: { harden: boolean } = { harden: true },
): Child {
  const isNumeric = /^\d+$/.test(uidOrUser);
  const privArgs = isNumeric
    ? ["--reuid", uidOrUser, "--regid", uidOrUser, "--clear-groups"]
    : ["--reuid", uidOrUser, "--regid", uidOrUser, "--init-groups"];
  if (opts.harden) privArgs.push("--no-new-privs", "--bounding-set", "-all");
  const proc: ChildProcess = spawn("setpriv", [...privArgs, "--", ...argv], {
    cwd,
    // The platform-built env maps don't carry PATH; inherit the guest's
    // (set by init) so workload children can resolve bun/python/etc.
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", ...env, HOME: cwd },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const exited = new Promise<number>((resolve) => {
    // POSIX 128+n signal exit codes, mirroring what the docker adapter
    // reports for the same death (Docker's ExitCode follows this
    // convention). Preserving the signal number (vs flattening every
    // signal to 137) keeps a SIGSEGV crash from being misdiagnosed as an
    // OOM kill in the run's user-facing error. `os.constants.signals`
    // supplies the name→number map; the ?? 9 fallback yields 137 (SIGKILL).
    proc.on("exit", (code: number | null, signal: NodeJS.Signals | null) =>
      resolve(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 9) : 1)),
    );
    proc.on("error", (err: Error) => {
      log(`spawn error for ${argv[0]}: ${err.message}`);
      // 126 (the supervisor's fail-to-launch code), not 1 — a spawn
      // failure must not be confusable with the workload's own exit 1.
      resolve(126);
    });
  });
  return { pid: proc.pid ?? -1, exited, kill: () => proc.kill("SIGKILL") };
}

/** MMDS V2 store shape — the broker payload the daemon PUT (snake_case wire). */
interface MmdsStore {
  sidecar_env?: Record<string, string>;
  agent_env?: Record<string, string>;
}

/**
 * Credential broker (GuestConfig.credentials.source === "mmds"): the run's
 * secret keys are NOT on the config drive — fetch them from the Firecracker
 * MMDS store and merge them over the drive-provided env maps (MMDS wins on
 * key collision). The daemon PUTs the store just after boot, so a bounded
 * retry (~20s) absorbs the race where the guest wins it. On final failure
 * this FAIL-CLOSES the run — a sidecar without its credentials would
 * silently misbehave.
 */
async function fetchAndMergeMmdsCredentials(cfg: GuestConfig): Promise<void> {
  // Explicit link-local /32 route out eth0 — robust against ARP/gateway
  // edge cases for the metadata address. Idempotent-ish; ignore "exists".
  await runHostCmd(["ip", "route", "add", `${MMDS_IPV4_ADDRESS}/32`, "dev", "eth0"]).catch(
    () => {},
  );

  const deadline = Date.now() + 20_000;
  let attempt = 0;
  let lastErr = "";
  while (Date.now() < deadline) {
    attempt++;
    try {
      const store = await fetchMmdsStore();
      if (store.sidecar_env) Object.assign(cfg.sidecar.env, store.sidecar_env);
      if (store.agent_env) Object.assign(cfg.agent.env, store.agent_env);
      log(`fetched credentials from MMDS (attempt ${attempt})`);
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await delay(Math.min(1000, 100 * attempt));
  }
  fatal(`MMDS credential fetch failed after ${attempt} attempts: ${lastErr}`);
}

/** One MMDS V2 fetch: PUT a session token, then GET the store root as JSON. */
async function fetchMmdsStore(): Promise<MmdsStore> {
  const tokenRes = await fetch(`http://${MMDS_IPV4_ADDRESS}/latest/api/token`, {
    method: "PUT",
    headers: { "X-metadata-token-ttl-seconds": "60" },
    signal: AbortSignal.timeout(3_000),
  });
  if (!tokenRes.ok) throw new Error(`token PUT HTTP ${tokenRes.status}`);
  const token = (await tokenRes.text()).trim();
  const res = await fetch(`http://${MMDS_IPV4_ADDRESS}/`, {
    headers: { "X-metadata-token": token, Accept: "application/json" },
    signal: AbortSignal.timeout(3_000),
  });
  if (!res.ok) throw new Error(`store GET HTTP ${res.status}`);
  const raw: unknown = await res.json();
  if (typeof raw !== "object" || raw === null) throw new Error("MMDS store is not an object");
  return raw as MmdsStore;
}

async function main(): Promise<void> {
  const cfg = readConfig();
  exitNonce = cfg.exit_marker_nonce;
  log(`run ${cfg.run_id} starting (sidecar=${cfg.sidecar.enabled})`);

  // Credential broker: fetch the run's secrets from MMDS BEFORE the firewall
  // goes up (applyFirewall then drops MMDS for every uid). Only the root
  // supervisor runs at this point — no workload exists yet, so the
  // pre-firewall window is never exposed to untrusted code.
  if (cfg.credentials.source === "mmds") {
    await fetchAndMergeMmdsCredentials(cfg);
  }

  await applyFirewall(runHostCmd, cfg).catch((err: Error) => {
    // Fail closed: without the firewall the agent could bypass the sidecar
    // proxy. Refuse to launch rather than run unisolated.
    fatal(`firewall setup failed: ${err.message}`);
  });

  // The config drive carries the whole launch spec — sidecar credentials
  // included. Nothing rereads it after this point: unmount BEFORE any
  // workload exists so no in-guest uid can ever read it back.
  await runHostCmd(["umount", "/config"]).catch((err: Error) => {
    fatal(`could not unmount config drive: ${err.message}`);
  });

  // The umount removes the filesystem view, but the raw /dev/vdb block node
  // survives in devtmpfs — the launch spec (credentials + exit nonce) would
  // be recoverable via `dd if=/dev/vdb` if the node perms allowed it. Do not
  // rely on devtmpfs defaults (root:disk): ENFORCE root:root 0000 so no
  // workload uid can ever open the device. Same fail-closed contract as the
  // umount above — refuse to spawn anything if the lockdown fails.
  try {
    chownSync("/dev/vdb", 0, 0);
    chmodSync("/dev/vdb", 0o000);
  } catch (err) {
    fatal(`could not lock down /dev/vdb: ${err instanceof Error ? err.message : String(err)}`);
  }

  let sidecar: Child | undefined;
  if (cfg.sidecar.enabled) {
    sidecar = spawnAs(
      GUEST_SIDECAR_UID,
      [SIDECAR_BIN],
      // The wrapper path rides the env (not the adapter's own config): the
      // process adapter is shared with host process-mode, where runners
      // stay plain children of the sidecar.
      {
        ...cfg.sidecar.env,
        APPSTRATE_RUNNER_EXEC: RUNNER_EXEC_WRAPPER,
        APPSTRATE_BROWSER_DRIVER_EXEC: RUNNER_EXEC_WRAPPER,
        APPSTRATE_BROWSER_EXEC: BROWSER_EXEC_WRAPPER,
        APPSTRATE_BROWSER_EXECUTABLE: BROWSER_EXECUTABLE,
        APPSTRATE_BROWSER_GUEST_ISOLATION: "1",
      },
      "/tmp",
      { harden: false },
    );
    log(`sidecar pid ${sidecar.pid}`);
  }

  // The agent is the primary workload; its exit is the run's outcome. The
  // sidecar's HTTP listener may not be up yet — the agent's MCP handshake
  // retries with backoff (same parallel-boot contract as docker/process).
  const agent = spawnAs(
    GUEST_AGENT_USER,
    cfg.agent.argv ?? ["/usr/local/bin/bun", "run", AGENT_ENTRY],
    { BUN_RUNTIME_TRANSPILER_CACHE_PATH: TRANSPILER_CACHE_PATH, ...cfg.agent.env },
    "/workspace",
  );
  log(`agent pid ${agent.pid}`);

  const code = await agent.exited;
  log(`agent exited ${code}`);

  if (sidecar) {
    sidecar.kill();
    await Promise.race([sidecar.exited, delay(2000)]);
  }

  printExitMarker(code);
  powerOff();
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Host-side nonce proving the marker came from THIS supervisor, not from a
 * workload pre-printing `APPSTRATE_EXIT:0` on the shared serial console to
 * forge a success after being killed. Set from the config drive; a marker
 * without the nonce is ignored by the host's parseExitMarker.
 */
let exitNonce = "";

function printExitMarker(code: number): void {
  // Blocking write(2) straight to fd 1 — process.stdout.write() queues in
  // the runtime and the bytes can still be in flight when powerOff() fires
  // the SysRq. Observed live: marker truncated mid-nonce, interleaved with
  // the kernel's "sysrq: Resetting" printk, so the host read no valid
  // marker and reported a clean agent exit as a crash.
  writeFileSync(1, `APPSTRATE_EXIT:${exitNonce}:${code}\n`);
}

function powerOff(): never {
  // Terminate the VMM via the magic SysRq. Arch-specific on purpose:
  //   - aarch64: SysRq "o" (power off) → PSCI SYSTEM_OFF → the VMM exits.
  //   - x86_64: Firecracker emulates no ACPI S5 poweroff, so "o" HALTS
  //     the vCPU without ending the VMM (the host's waitForExit would
  //     hang forever). A guest reboot ("b"), which Firecracker
  //     deliberately does not implement, terminates the VMM instead —
  //     the canonical x86 Firecracker exit path (with `reboot=k` on the
  //     kernel cmdline).
  const sysrq = process.arch === "x64" ? "b" : "o";
  // Let the serial line discipline drain the exit marker to the UART —
  // even a blocking write(2) returns once the bytes sit in the tty output
  // buffer, not when the VMM has consumed them. 200ms is orders of
  // magnitude above one line's drain time and invisible next to boot cost.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  try {
    writeFileSync("/proc/sysrq-trigger", sysrq);
  } catch {
    // Fall through to reboot(8)/poweroff(8) if sysrq is unavailable.
  }
  try {
    spawn(process.arch === "x64" ? "reboot" : "poweroff", ["-f"], { stdio: "ignore" });
  } catch {
    // Nothing left to try.
  }
  // Block forever — the VM is going down; never return control to init.
  while (true) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
}

if (import.meta.main) {
  void main().catch((err) => {
    log(`FATAL: ${err instanceof Error ? err.stack : String(err)}`);
    // Before the config is read the nonce is empty — the host then ignores
    // the marker and reports a non-clean exit, which is the right outcome
    // for a supervisor crash anyway.
    printExitMarker(125);
    powerOff();
  });
}
