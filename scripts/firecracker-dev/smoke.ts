// SPDX-License-Identifier: Apache-2.0

/**
 * Firecracker orchestrator smoke test — exercises the REAL machinery
 * end-to-end on a KVM host, without a platform instance:
 *
 *   initialize (host net + artifact checks) → boundary (TAP + /30) →
 *   sidecar spec + agent workload → VM boot (config drive, overlay init,
 *   guest firewall, setpriv uid drop) → exit-marker round-trip → teardown.
 *
 * The agent argv is overridden with a trivial command (the smoke-only DI
 * seam), so success asserts the boot machinery, not an LLM run:
 * `waitForExit` must observe the guest's APPSTRATE_EXIT:0 marker.
 *
 * Run inside the Lima dev VM / a Linux KVM host via
 * `bun run test:firecracker` (scripts/firecracker-dev/vm-smoke.sh).
 */

/* eslint-disable no-console -- standalone dev harness, not platform code */

// Minimal env so @appstrate/env validates without a real platform config.
process.env.BETTER_AUTH_SECRET ??= "smoke-secret-not-a-real-deployment";
process.env.CONNECTION_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.UPLOAD_SIGNING_SECRET ??= "smoke-upload-signing-secret";
process.env.RUN_ADAPTER = "firecracker";
process.env.FIRECRACKER_KERNEL_PATH ??= "./data/firecracker/vmlinux";
process.env.FIRECRACKER_ROOTFS_PATH ??= "./data/firecracker/rootfs.ext4";
process.env.FIRECRACKER_DATA_DIR ??= "./data/firecracker/runs";

const { FirecrackerOrchestrator } =
  await import("../../apps/api/src/services/orchestrator/firecracker/firecracker-orchestrator.ts");
const { platformAliasIp } =
  await import("../../apps/api/src/services/orchestrator/firecracker/subnet.ts");

const RUN_ID = `smoke_${process.pid}`;

function fail(msg: string): never {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

// Read the raw env (with the schema defaults) rather than @appstrate/env:
// scripts/ is not a workspace package, so the alias does not resolve here.
const aliasIp = platformAliasIp(process.env.FIRECRACKER_SUBNET_CIDR ?? "10.231.0.0/16");
const platformPort = Number(process.env.PORT ?? "3000");

// The probe script runs as the RESTRICTED agent (uid 1001, no
// unrestricted_egress): direct internet egress must be firewall-dropped,
// the platform alias must stay reachable, and the config drive must be
// gone (unmounted before workloads start). Each probe prints a marker the
// assertions below grep out of the serial console.
const PROBE_SCRIPT = [
  'echo "smoke-agent uid=$(id -u)"',
  `if wget -q -T 3 -O /dev/null http://1.1.1.1/ 2>/dev/null; then echo "smoke-egress=open"; else echo "smoke-egress=blocked"; fi`,
  `if wget -q -T 5 -O /dev/null "http://${aliasIp}:${platformPort}/" 2>/dev/null; then echo "smoke-platform=reachable"; else echo "smoke-platform=unreachable"; fi`,
  'if cat /config/config.json >/dev/null 2>&1; then echo "smoke-config=readable"; else echo "smoke-config=hidden"; fi',
  "exit 0",
].join(" && ");

const orch = new FirecrackerOrchestrator({
  // Validates: overlay boot, config drive parse + unmount, guest firewall
  // (egress blocked / platform allowed), setpriv uid drop (id -u must
  // print the agent uid), nonce-authenticated exit marker.
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
      setTimeout(() => reject(new Error("VM did not exit within 60s")), 60_000),
    ),
  ]);
  console.log(`==> guest exit marker: ${exitCode} (${Date.now() - bootStart} ms boot→exit)`);

  // Console diagnostics for the assertion below + human debugging.
  const consoleLog = await Bun.file(`${boundary.id}/console.log`)
    .text()
    .catch(() => "");
  const tail = consoleLog.split("\n").slice(-40).join("\n");
  console.log("---- guest console (tail) ----");
  console.log(tail);
  console.log("------------------------------");

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

  console.log("==> teardown");
  await orch.removeWorkload(sidecar);
  await orch.removeWorkload(agent);
} finally {
  platformStub.stop(true);
  await orch.removeIsolationBoundary(boundary).catch(() => {});
  await orch.shutdown().catch(() => {});
}

console.log("SMOKE PASS");
