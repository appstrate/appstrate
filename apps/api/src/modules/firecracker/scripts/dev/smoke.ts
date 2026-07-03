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

const RUN_ID = `smoke_${process.pid}`;

function fail(msg: string): never {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
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

try {
  console.log("==> workloads");
  const sidecar = await orch.createSidecar(RUN_ID, boundary, { runToken: "smoke-token" });
  const agent = await orch.createWorkload(
    {
      runId: RUN_ID,
      role: "agent",
      image: "unused-by-firecracker",
      env: { SMOKE: "1" },
      resources: { memoryBytes: 512 * 1024 * 1024, nanoCpus: 1_000_000_000 },
    },
    boundary,
  );

  console.log("==> boot microVM");
  const bootStart = Date.now();
  await orch.startWorkload(agent);

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
} catch (err) {
  await dumpConsole(boundary.id, "vm1 exception");
  throw err;
} finally {
  platformStub.stop(true);
  await orch.removeIsolationBoundary(boundary).catch(() => {});
  await orch.shutdown().catch(() => {});
}

console.log("SMOKE PASS");
