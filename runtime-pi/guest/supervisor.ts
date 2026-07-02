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
import { readFileSync, writeFileSync } from "node:fs";

const GUEST_SIDECAR_UID = "1000";
const GUEST_AGENT_UID = "1001";
const GUEST_AGENT_USER = "pi"; // uid 1001, baked into the rootfs
const SIDECAR_BIN = "/usr/local/bin/sidecar";
const AGENT_ENTRY = "/runtime/dist/entrypoint.js";
const CONFIG_PATH = "/config/config.json";

interface GuestConfig {
  run_id: string;
  network: { platform_ip: string; platform_port: number };
  sidecar: { enabled: boolean; env: Record<string, string> };
  agent: {
    env: Record<string, string>;
    unrestricted_egress: boolean;
    /**
     * Agent command override. Absent in production (the orchestrator
     * always launches the baked runtime entrypoint); the dev smoke
     * harness (scripts/firecracker-dev/) sets it to validate the boot
     * machinery without a live platform.
     */
    argv?: string[];
  };
}

function log(msg: string): void {
  process.stdout.write(`[supervisor] ${msg}\n`);
}

function readConfig(): GuestConfig {
  const raw: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  if (typeof raw !== "object" || raw === null) {
    throw new Error("config.json is not an object");
  }
  return raw as GuestConfig;
}

/**
 * Guest egress firewall (nftables `inet` family).
 *
 *   - loopback: always allowed (agent ↔ sidecar traffic rides 127.0.0.1).
 *   - sidecar uid: full egress (it fronts the LLM proxy + forward proxy).
 *   - agent uid: allowed to loopback + the platform sink only, UNLESS the
 *     run is skipSidecar (then the agent needs direct upstream egress).
 *   - everything else from the agent uid is dropped, so the agent cannot
 *     bypass the sidecar's forward proxy to reach the internet directly.
 *
 * DNS to the configured resolvers is allowed for whoever has egress
 * (sidecar always, agent only when unrestricted) via the general accept
 * rules below — no special-casing needed.
 */
function applyFirewall(exec: RunHostCmd, cfg: GuestConfig): Promise<void> {
  const agentEgress = cfg.agent.unrestricted_egress
    ? `      meta skuid ${GUEST_AGENT_UID} accept`
    : [
        `      meta skuid ${GUEST_AGENT_UID} ip daddr 127.0.0.1 accept`,
        `      meta skuid ${GUEST_AGENT_UID} ip daddr ${cfg.network.platform_ip} tcp dport ${cfg.network.platform_port} accept`,
        `      meta skuid ${GUEST_AGENT_UID} drop`,
      ].join("\n");

  const script = [
    `table inet appstrate_guest {`,
    `  chain output {`,
    `    type filter hook output priority filter; policy accept;`,
    `    oifname "lo" accept`,
    `    meta skuid ${GUEST_SIDECAR_UID} accept`,
    agentEgress,
    `  }`,
    `}`,
    ``,
  ].join("\n");
  return exec(["nft", "-f", "-"], script);
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
 */
function spawnAs(
  uidOrUser: string,
  argv: string[],
  env: Record<string, string>,
  cwd: string,
): Child {
  const isNumeric = /^\d+$/.test(uidOrUser);
  const privArgs = isNumeric
    ? ["--reuid", uidOrUser, "--regid", uidOrUser, "--clear-groups"]
    : ["--reuid", uidOrUser, "--regid", uidOrUser, "--init-groups"];
  const proc: ChildProcess = spawn("setpriv", [...privArgs, "--", ...argv], {
    cwd,
    // The platform-built env maps don't carry PATH; inherit the guest's
    // (set by init) so workload children can resolve bun/python/etc.
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", ...env, HOME: cwd },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const exited = new Promise<number>((resolve) => {
    proc.on("exit", (code: number | null, signal: string | null) =>
      resolve(code ?? (signal ? 137 : 1)),
    );
    proc.on("error", (err: Error) => {
      log(`spawn error for ${argv[0]}: ${err.message}`);
      resolve(1);
    });
  });
  return { pid: proc.pid ?? -1, exited, kill: () => proc.kill("SIGKILL") };
}

async function main(): Promise<void> {
  const cfg = readConfig();
  log(`run ${cfg.run_id} starting (sidecar=${cfg.sidecar.enabled})`);

  await applyFirewall(runHostCmd, cfg).catch((err) => {
    // Fail closed: without the firewall the agent could bypass the sidecar
    // proxy. Refuse to launch rather than run unisolated.
    log(`FATAL: firewall setup failed: ${err.message}`);
    process.stdout.write("APPSTRATE_EXIT:126\n");
    powerOff();
  });

  let sidecar: Child | undefined;
  if (cfg.sidecar.enabled) {
    sidecar = spawnAs(GUEST_SIDECAR_UID, [SIDECAR_BIN], cfg.sidecar.env, "/tmp");
    log(`sidecar pid ${sidecar.pid}`);
  }

  // The agent is the primary workload; its exit is the run's outcome. The
  // sidecar's HTTP listener may not be up yet — the agent's MCP handshake
  // retries with backoff (same parallel-boot contract as docker/process).
  const agent = spawnAs(
    GUEST_AGENT_USER,
    cfg.agent.argv ?? ["/usr/local/bin/bun", "run", AGENT_ENTRY],
    cfg.agent.env,
    "/workspace",
  );
  log(`agent pid ${agent.pid}`);

  const code = await agent.exited;
  log(`agent exited ${code}`);

  if (sidecar) {
    sidecar.kill();
    await Promise.race([sidecar.exited, delay(2000)]);
  }

  process.stdout.write(`APPSTRATE_EXIT:${code}\n`);
  powerOff();
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

main().catch((err) => {
  log(`FATAL: ${err instanceof Error ? err.stack : String(err)}`);
  process.stdout.write("APPSTRATE_EXIT:125\n");
  powerOff();
});
