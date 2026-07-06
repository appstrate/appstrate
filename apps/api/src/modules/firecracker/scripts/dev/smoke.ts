// SPDX-License-Identifier: Apache-2.0

/**
 * Firecracker orchestrator smoke test — exercises the REAL machinery
 * end-to-end on a KVM host, without a platform instance:
 *
 *   initialize (host net + artifact checks) → boundary (TAP + /30) →
 *   sidecar spec + agent workload → VM boot (config drive, overlay init,
 *   guest firewall, setpriv uid drop) → exit-marker round-trip → teardown.
 *
 * The agent argv is overridden with a probe script (the smoke-only DI
 * seam), so success asserts the boot machinery, not an LLM run:
 * `waitForExit` must observe the guest's APPSTRATE_EXIT:0 marker.
 *
 * A SECOND minimal VM then asserts non-zero exit-code propagation
 * (`exit 42` → waitForExit 42) — without it, a supervisor hardcoding 0
 * would pass CI.
 *
 * With FIRECRACKER_JAILER=on (the default) the smoke also asserts the
 * jail: the live VMM runs as its reserved per-VM uid, the chroot holds
 * ONLY the expected entries, and the jail tree dies with the teardown.
 * Requires root in that mode (vm-smoke.sh sudo-wraps this script).
 *
 * Run inside the Lima dev VM / a Linux KVM host via
 * `bun run test:firecracker` (apps/api/src/modules/firecracker/scripts/dev/vm-smoke.sh).
 */

// Only the host-side FIRECRACKER_* vars the orchestrator reads via
// getFirecrackerEnv() — no platform secrets: the orchestrator is now
// decoupled from @appstrate/env (it is the daemon's engine, not a
// platform adapter), so this dev harness drives it with FIRECRACKER_*
// alone.
process.env.FIRECRACKER_KERNEL_PATH ??= "./data/firecracker/vmlinux";
process.env.FIRECRACKER_ROOTFS_PATH ??= "./data/firecracker/rootfs.ext4";
process.env.FIRECRACKER_DATA_DIR ??= "./data/firecracker/runs";

const { FirecrackerOrchestrator } = await import("../../orchestrator.ts");
const { platformAliasIp } = await import("../../subnet.ts");
const { readdir, stat } = await import("node:fs/promises");
const { dirname, join } = await import("node:path");

const RUN_ID = `smoke_${process.pid}`;
/** Jailer confinement is the orchestrator default — assert it end-to-end. */
const JAILER_ON = (process.env.FIRECRACKER_JAILER ?? "on") === "on";
/** Credential broker — MMDS is the orchestrator default. */
const BROKER = process.env.FIRECRACKER_CREDENTIAL_BROKER ?? "mmds";
/**
 * Distinctive fake run token pushed through the sidecar env. In MMDS mode
 * it must be brokered in-memory (NOT written to the config drive) — the
 * drive-inspection assertion below greps the staged ext4 image for it.
 */
const FAKE_RUN_TOKEN = "smoke-fake-secret-DEADBEEFCAFE";
/**
 * Distinctive fake model API key pushed through the AGENT env. In MMDS
 * mode it must be brokered too (skipSidecar/direct-provider runs put the
 * REAL provider key in the agent env — regression guard for it landing
 * on the config drive).
 */
const FAKE_MODEL_KEY = "sk-smoke-fake-model-key-0DEFACED";

function fail(msg: string): never {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

/**
 * Jail assertions while the VMM is ALIVE: (a) the VMM process runs as
 * the run's reserved jail uid (root would mean the privilege drop
 * silently failed), (b) the chroot contains ONLY the expected entries —
 * anything else means files are leaking into the jail. Returns the jail
 * dir so the post-teardown check can assert it is gone.
 */
async function assertJailedVmm(runDir: string): Promise<string> {
  const state = JSON.parse(await Bun.file(join(runDir, "state.json")).text()) as {
    pid?: number;
    jailUid?: number;
    chrootPath?: string;
  };
  if (!state.pid || !state.jailUid || !state.chrootPath) {
    fail(`state.json is missing the jail fields: ${JSON.stringify(state)}`);
  }
  // Poll: the spawn handle exists from t0 but the jailer only drops to
  // the jail uid after its chroot/cgroup setup (a few ms) — a single
  // immediate read could race and observe the still-root setup phase.
  const readUid = async (): Promise<number> => {
    const status = await Bun.file(`/proc/${state.pid}/status`)
      .text()
      .catch(() => "");
    return Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? -1);
  };
  let uid = await readUid();
  for (let i = 0; i < 50 && uid !== state.jailUid; i++) {
    await new Promise((r) => setTimeout(r, 100));
    uid = await readUid();
  }
  if (uid !== state.jailUid) {
    fail(`VMM pid ${state.pid} runs as uid ${uid}, expected jail uid ${state.jailUid}`);
  }
  console.log(`    jailed VMM ok: pid ${state.pid} uid ${uid}`);

  // `firecracker` = the exec copy the jailer makes; `firecracker.pid` = the
  // pidfile the jailer writes beside it (the handle a future --new-pid-ns
  // move would track the VMM through — see jail.ts); `dev` + `run` are the
  // jailer-created device/socket dirs; the other four are ours.
  const allowed = new Set([
    "firecracker",
    "firecracker.pid",
    "vmlinux",
    "rootfs.ext4",
    "config.img",
    "vmconfig.json",
    "dev",
    "run",
  ]);
  const entries = await readdir(state.chrootPath);
  const unexpected = entries.filter((e) => !allowed.has(e));
  if (unexpected.length > 0) {
    fail(`unexpected entries in the chroot: ${unexpected.join(", ")}`);
  }
  for (const required of ["vmlinux", "rootfs.ext4", "config.img", "vmconfig.json"]) {
    if (!entries.includes(required)) fail(`chroot is missing ${required}`);
  }
  console.log(`    chroot contents ok: ${entries.sort().join(", ")}`);
  return dirname(state.chrootPath);
}

/**
 * Credential broker (MMDS): read the staged read-only ext4 config drive
 * back with debugfs and assert the fake run token is ABSENT — proof the
 * secret keys were stripped off the drive and delivered via MMDS instead.
 * `imagePath` is `<chroot>/config.img` (jailer) or `<runDir>/config.img`
 * (direct). Runs as root (the image is 0400, owned by the jail uid).
 */
async function assertConfigDriveOmitsSecret(imagePath: string, secret: string): Promise<void> {
  const proc = Bun.spawn(["debugfs", "-R", "cat /config.json", imagePath], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  if (text.length === 0) {
    fail(`could not read config.json from ${imagePath} to verify secret redaction`);
  }
  if (text.includes(secret)) {
    fail("config drive still contains the run token — MMDS credential split not applied");
  }
  console.log("    config drive omits the MMDS-brokered secret ok");
}

/**
 * Print the guest console tail. MUST run before removeIsolationBoundary
 * on every failure path: teardown rm -rf's the run dir (console.log
 * included), so a timeout/exception would otherwise leave zero
 * diagnostics — in CI the failure-artifact upload step would silently
 * find nothing (`if-no-files-found: ignore`).
 */
async function dumpConsole(runDir: string, label: string): Promise<void> {
  const text = await Bun.file(`${runDir}/console.log`)
    .text()
    .catch(() => "(console.log unreadable)");
  console.log(`---- guest console (${label}, tail) ----`);
  console.log(text.split("\n").slice(-60).join("\n"));
  console.log("------------------------------");
}

// Read the raw env (with the schema defaults) rather than @appstrate/env:
// scripts/ is not a workspace package, so the alias does not resolve here.
const aliasIp = platformAliasIp(process.env.FIRECRACKER_SUBNET_CIDR ?? "10.231.0.0/16");
const platformPort = Number(process.env.PORT ?? "3000");

// The probe script runs as the RESTRICTED agent (uid 1001, no
// unrestricted_egress): direct internet egress must be firewall-dropped,
// the platform alias must stay reachable, the config drive must be gone
// (unmounted before workloads start) AND its raw block node unreadable,
// the in-guest sidecar must answer its /health endpoint, and hidepid=2
// must hide foreign-uid /proc entries. Each probe prints a marker the
// assertions below grep out of the serial console. Probes are if/else
// (always exit 0) so one failure doesn't mask the markers after it.
const PROBE_SCRIPT = [
  'echo "smoke-agent uid=$(id -u)"',
  `if wget -q -T 3 -O /dev/null http://1.1.1.1/ 2>/dev/null; then echo "smoke-egress=open"; else echo "smoke-egress=blocked"; fi`,
  `if wget -q -T 5 -O /dev/null "http://${aliasIp}:${platformPort}/" 2>/dev/null; then echo "smoke-platform=reachable"; else echo "smoke-platform=unreachable"; fi`,
  'if cat /config/config.json >/dev/null 2>&1; then echo "smoke-config=readable"; else echo "smoke-config=hidden"; fi',
  // Raw config-drive block node: the supervisor chmod 000s /dev/vdb after
  // the umount — a readable node would leak the whole launch spec
  // (credentials + exit nonce) to any workload uid.
  'if dd if=/dev/vdb of=/dev/null count=1 2>/dev/null; then echo "smoke-vdb=readable"; else echo "smoke-vdb=blocked"; fi',
  // Credential broker: after the supervisor fetched the secrets, the guest
  // firewall drops all access to the MMDS metadata address for EVERY uid.
  // A workload reaching it would be a credential-store leak. The probe
  // performs the REAL V2 handshake step (token PUT) via bun: a tokenless
  // wget GET would 401 under MMDS V2 even with NO firewall rule at all,
  // reading as "blocked" and making the assertion tautological. The token
  // PUT succeeds whenever MMDS is reachable — only the firewall DROP
  // (connect timeout) makes it fail.
  `if bun -e "const ok=await fetch('http://169.254.169.254/latest/api/token',{method:'PUT',headers:{'X-metadata-token-ttl-seconds':'60'},signal:AbortSignal.timeout(3000)}).then(r=>r.ok,()=>false);process.exit(ok?0:1)" >/dev/null 2>&1; then echo "smoke-mmds=reachable"; else echo "smoke-mmds=blocked"; fi`,
  // In-guest sidecar liveness: /health must answer 200 (wget fails on
  // 503). The sidecar cold-starts in parallel with the agent, so retry
  // for up to 30s — a sidecar that crashed at ms 1 never answers.
  '{ i=0; ok=0; while [ "$i" -lt 30 ]; do if wget -q -T 2 -O /dev/null http://127.0.0.1:8080/health 2>/dev/null; then ok=1; break; fi; i=$((i+1)); sleep 1; done; if [ "$ok" = 1 ]; then echo "smoke-sidecar=up"; else echo "smoke-sidecar=down"; fi; }',
  // hidepid=2: foreign-uid /proc entries must be invisible to the agent
  // (the sidecar's environ carries the run credentials). PID 1 is the
  // root supervisor: with hidepid=2 its /proc dir does not exist for
  // uid 1001; with hidepid=0/1 it is still listable (-d true). Every
  // pid dir the agent CAN see must belong to it (environ readable) —
  // a visible-but-unreadable entry means hidepid<2.
  '{ leak=0; [ -d /proc/1 ] && leak=1; cat /proc/1/environ >/dev/null 2>&1 && leak=1; for d in /proc/[0-9]*/environ; do [ -e "$d" ] || continue; cat "$d" >/dev/null 2>&1 || leak=1; done; if [ "$leak" = 0 ]; then echo "smoke-hidepid=enforced"; else echo "smoke-hidepid=leaky"; fi; }',
  "exit 0",
].join(" && ");

const orch = new FirecrackerOrchestrator({
  // Validates: overlay boot, config drive parse + unmount + /dev/vdb
  // lockdown, guest firewall (egress blocked / platform allowed), setpriv
  // uid drop (id -u must print the agent uid), in-guest sidecar liveness,
  // hidepid=2, nonce-authenticated exit marker.
  agentArgvOverride: ["/bin/sh", "-c", PROBE_SCRIPT],
});

console.log("==> initialize");
await orch.initialize();
await orch.cleanupOrphans();

// Stand-in for the platform API on the loopback alias — gives the guest's
// "platform reachable" probe something to answer it. Bound AFTER
// initialize() (which creates the alias).
const platformStub = Bun.serve({
  hostname: aliasIp,
  port: platformPort,
  fetch: () => new Response("ok"),
});

console.log("==> boundary");
const boundary = await orch.createIsolationBoundary(RUN_ID);
console.log(`    tap+subnet ok, endpoints: ${boundary.sidecarEndpoints.sidecarUrl}`);

/** Set while VM1 runs (jailer mode) — asserted gone after teardown. */
let vm1JailDir: string | null = null;

try {
  console.log("==> workloads");
  const sidecar = await orch.createSidecar(RUN_ID, boundary, { runToken: FAKE_RUN_TOKEN });
  const agent = await orch.createWorkload(
    {
      runId: RUN_ID,
      role: "agent",
      image: "unused-by-firecracker",
      env: { SMOKE: "1", MODEL_API_KEY: FAKE_MODEL_KEY },
      resources: { memoryBytes: 512 * 1024 * 1024, nanoCpus: 1_000_000_000 },
    },
    boundary,
  );

  console.log("==> boot microVM");
  const bootStart = Date.now();
  await orch.startWorkload(agent);

  // Jail identity + chroot hygiene, checked while the VMM is alive (the
  // probe script keeps the guest up long enough).
  if (JAILER_ON) vm1JailDir = await assertJailedVmm(boundary.id);

  // Credential broker: the config drive must NOT carry the fake run token in
  // MMDS mode (it is delivered in-memory). config.img is inside the chroot
  // when jailed, else in the run dir. Read it back while the VM is alive.
  if (BROKER === "mmds") {
    const state = JSON.parse(await Bun.file(join(boundary.id, "state.json")).text()) as {
      chrootPath?: string;
    };
    const imagePath =
      JAILER_ON && state.chrootPath
        ? join(state.chrootPath, "config.img")
        : join(boundary.id, "config.img");
    await assertConfigDriveOmitsSecret(imagePath, FAKE_RUN_TOKEN);
    // Agent-env secret: the model API key (real on direct-provider runs)
    // must be brokered off the drive too.
    await assertConfigDriveOmitsSecret(imagePath, FAKE_MODEL_KEY);
  }

  const exitCode = await Promise.race([
    orch.waitForExit(agent),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("VM did not exit within 90s")), 90_000),
    ),
  ]);
  console.log(`==> guest exit marker: ${exitCode} (${Date.now() - bootStart} ms boot→exit)`);

  // Console diagnostics for the assertion below + human debugging.
  const consoleLog = await Bun.file(`${boundary.id}/console.log`)
    .text()
    .catch(() => "");
  await dumpConsole(boundary.id, "vm1");

  if (exitCode !== 0) fail(`expected exit marker 0, got ${exitCode}`);
  if (!consoleLog.includes("smoke-agent uid=1001")) {
    fail("agent output missing or wrong uid — setpriv drop not effective");
  }
  if (!consoleLog.includes("[supervisor] sidecar pid")) {
    fail("supervisor did not report a sidecar pid");
  }
  if (!consoleLog.includes("smoke-egress=blocked")) {
    fail("restricted agent reached the internet directly — guest egress firewall not effective");
  }
  if (!consoleLog.includes("smoke-platform=reachable")) {
    fail("agent could not reach the platform alias — host input allow or guest allow broken");
  }
  if (!consoleLog.includes("smoke-config=hidden")) {
    fail("agent could read /config/config.json — config drive not unmounted before workloads");
  }
  if (!consoleLog.includes("smoke-vdb=blocked")) {
    fail("agent could read the raw config-drive node — /dev/vdb not locked down post-umount");
  }
  if (!consoleLog.includes("smoke-sidecar=up")) {
    fail("in-guest sidecar /health never answered 200 — sidecar crashed or never listened");
  }
  if (!consoleLog.includes("smoke-hidepid=enforced")) {
    fail("agent can see foreign-uid /proc entries — hidepid=2 not effective");
  }
  if (!consoleLog.includes("smoke-mmds=blocked")) {
    fail("agent reached the MMDS metadata address — guest credential-store firewall not effective");
  }

  console.log("==> teardown");
  await orch.removeWorkload(sidecar);
  await orch.removeWorkload(agent);

  // ---------------------------------------------------------------------
  // Second minimal VM: non-zero exit-code propagation. No sidecar (the
  // skipSidecar path), trivial agent — the guest's `exit 42` must round-
  // trip through the nonce-authenticated marker to waitForExit.
  // ---------------------------------------------------------------------
  console.log("==> second microVM (exit-code propagation)");
  const RUN_ID2 = `${RUN_ID}_exit42`;
  // Same smoke-only DI seam as the constructor arg — swapped between runs
  // because the override is per-orchestrator, not per-run.
  Reflect.set(orch, "agentArgvOverride", ["/bin/sh", "-c", "exit 42"]);
  const boundary2 = await orch.createIsolationBoundary(RUN_ID2);
  try {
    const agent2 = await orch.createWorkload(
      {
        runId: RUN_ID2,
        role: "agent",
        image: "unused-by-firecracker",
        env: {},
        resources: { memoryBytes: 256 * 1024 * 1024, nanoCpus: 1_000_000_000 },
      },
      boundary2,
    );
    await orch.startWorkload(agent2);
    const exitCode2 = await Promise.race([
      orch.waitForExit(agent2),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("second VM did not exit within 90s")), 90_000),
      ),
    ]);
    console.log(`==> second guest exit marker: ${exitCode2}`);
    await dumpConsole(boundary2.id, "vm2");
    if (exitCode2 !== 42) {
      fail(`expected exit marker 42 from the second VM, got ${exitCode2}`);
    }
    await orch.removeWorkload(agent2);
  } catch (err) {
    await dumpConsole(boundary2.id, "vm2 exception");
    throw err;
  } finally {
    await orch.removeIsolationBoundary(boundary2).catch(() => {});
  }

  // ---------------------------------------------------------------------
  // Third VM (B4): the REAL agent entrypoint — NO argv override, so the
  // supervisor runs the baked default `bun run /runtime/dist/entrypoint.js`.
  // skipSidecar + a minimal agent env (no valid platform sink) makes the
  // bundle LOAD, run under bun in-guest, and fail env validation — leaving
  // runtime-pi's `[runtime-pi fatal]` last-resort line on the serial
  // console. This catches module-resolution / transpiler breakage that the
  // /bin/sh probes above cannot see.
  // ---------------------------------------------------------------------
  console.log("==> third microVM (real entrypoint boot probe)");
  const RUN_ID3 = `${RUN_ID}_realentry`;
  // Clear the smoke DI seam → supervisor uses the default agent argv.
  Reflect.set(orch, "agentArgvOverride", undefined);
  const boundary3 = await orch.createIsolationBoundary(RUN_ID3);
  try {
    // No createSidecar → skipSidecar path. Minimal env: the entrypoint's
    // parseRuntimeEnv fails fast on the missing APPSTRATE_SINK_* contract.
    const agent3 = await orch.createWorkload(
      {
        runId: RUN_ID3,
        role: "agent",
        image: "unused-by-firecracker",
        env: { AGENT_RUN_ID: RUN_ID3 },
        resources: { memoryBytes: 512 * 1024 * 1024, nanoCpus: 1_000_000_000 },
      },
      boundary3,
    );
    await orch.startWorkload(agent3);
    await Promise.race([
      orch.waitForExit(agent3),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("third VM did not exit within 90s")), 90_000),
      ),
    ]);
    const console3 = await Bun.file(`${boundary3.id}/console.log`)
      .text()
      .catch(() => "");
    await dumpConsole(boundary3.id, "vm3");
    if (!console3.includes("[runtime-pi fatal]")) {
      fail(
        "real entrypoint did not emit '[runtime-pi fatal]' — the bundle failed to load/transpile " +
          "in-guest (module resolution or transpiler breakage), not a clean env-validation exit",
      );
    }
    console.log("==> real entrypoint loaded + reported its fatal diagnostic ok");
    await orch.removeWorkload(agent3);
  } catch (err) {
    await dumpConsole(boundary3.id, "vm3 exception");
    throw err;
  } finally {
    await orch.removeIsolationBoundary(boundary3).catch(() => {});
  }
} catch (err) {
  await dumpConsole(boundary.id, "vm1 exception");
  throw err;
} finally {
  platformStub.stop(true);
  await orch.removeIsolationBoundary(boundary).catch(() => {});
  await orch.shutdown().catch(() => {});
}

// Post-teardown jail hygiene: the per-run chroot tree must die with the
// boundary — a surviving jail dir would accumulate one rootfs hardlink +
// exec copy + (worse) a secret config drive per run.
if (vm1JailDir !== null) {
  const gone = await stat(vm1JailDir).then(
    () => false,
    () => true,
  );
  if (!gone) fail(`jail chroot tree survived teardown: ${vm1JailDir}`);
  console.log("==> jail chroot reclaimed on teardown");
}

console.log("SMOKE PASS");
