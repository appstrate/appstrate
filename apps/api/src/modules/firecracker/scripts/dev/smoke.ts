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
 * A FOURTH VM (#1547) boots the REAL sidecar with three local integrations
 * whose runners are one probe MCP server (served as a bundle by the platform
 * stub) in three roles — two plain-CONNECT runners with disjoint allowlists
 * and one `delivery.http` (MITM) runner whose credential the stub serves.
 * Each runner must land on its own pool uid with a private group, HOME and
 * umask; have no direct egress; reach only its `authorized_uris` through its
 * own listener (and, for proxy-unaware clients, the transparent plane); and be
 * refused by the agent's forward proxy and by a sibling's listener. The agent
 * must keep its forward proxy once runners exist, be refused by the runners'
 * listeners and the transparent plane, and see no sidecar TCP listener beyond
 * the known set (no inner MITM server on TCP).
 * REQUIRES INTERNET ACCESS from the KVM host: the guest's sidecar dials
 * example.com / example.org (the Lima dev VM and GitHub-hosted runners
 * have it).
 *
 * Run inside the Lima dev VM / a Linux KVM host via
 * `bun run test:firecracker` (apps/api/src/modules/firecracker/scripts/dev/vm-smoke.sh).
 */

import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";

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
const { GUEST_RUNNER_UID_FIRST, GUEST_RUNNER_UID_COUNT, GUEST_SIDECAR_UID } =
  await import("../../guest/firewall.ts");
const { zipSync } = await import("fflate");
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
 * mode it must be brokered too (regression guard for a credential-named
 * key landing on the config drive).
 */
const FAKE_MODEL_KEY = "sk-smoke-fake-model-key-0DEFACED";

const VM_EXIT_TIMEOUT_MS = 90_000;

// #1547 VM (fourth) timing. Generous on purpose: this smoke also runs under
// NESTED virtualization (Lima → Firecracker), where the guest cold start alone
// is ~40-90 s, the sidecar boots the three probe runners one after the other
// (each a cold `bun` start whose MCP handshake has exceeded 30 s), and every
// child `bun -e` probe is another cold start. Ordered: a runner gives up
// reporting (PEER_WAIT) before the agent stops waiting (AGENT_WAIT), which ends
// well inside the VM bound (VM_TIMEOUT = boot + AGENT_WAIT + the agent's own
// post-report probes).
/** Agent: bounded wait for every runner's final report. */
const RUNNER_EGRESS_AGENT_WAIT_MS = 240_000;
/** Host: VM4 boot → exit marker. */
const RUNNER_EGRESS_VM_TIMEOUT_MS = 420_000;
/** Runner: retrying its report to the agent, or a peer-address query. */
const RUNNER_EGRESS_PEER_WAIT_MS = 180_000;
/** One probe fetch or TLS handshake (runner and agent). */
const RUNNER_EGRESS_FETCH_TIMEOUT_MS = 20_000;
/** One child `bun -e` probe, its cold start included. */
const RUNNER_EGRESS_CHILD_TIMEOUT_MS = 60_000;

/**
 * Bound a VM exit wait without leaving the losing timeout alive. Bun keeps
 * referenced timers on its event loop, so a bare Promise.race made every
 * successful smoke wait ~90 seconds after `SMOKE PASS` before the process
 * could exit. Clearing in `finally` also covers early waitForExit failures.
 */
async function withExitTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = VM_EXIT_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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
  // Upstream's aarch64 jailer copies the host CPU cache/register identity
  // files under sys/devices/system/cpu/cpu0 so Firecracker can construct the
  // guest CPU topology. The x86_64 jailer does not create this directory.
  if (process.arch === "arm64") allowed.add("sys");
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

// The probe script runs as the agent (uid 1001): direct internet egress
// must be firewall-dropped, the platform alias must stay reachable, the
// config drive must be gone
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

// ---------------------------------------------------------------------------
// #1547 — integration runner egress (fourth VM). Three probe runners (one
// bundle, a role per integration) and the agent report raw observations as
// `RUNNER_EGRESS_1547 <reporter>.<probe>=<observation>` lines; the verdict is
// taken HOST-side, so a probe that did not run, or ran against the wrong
// target, fails instead of passing by default.
//
// Transport: the agent is the serial console's direct writer, so EVERY line
// the host asserts on is printed by the agent. A runner never relies on its
// stderr (runner stderr → sidecar log → console lost lines under nested virt:
// buffering, and the sidecar dies at poweroff); it delivers its lines to the
// agent over a loopback channel (127.0.0.1:RUNNER_EGRESS_DONE_PORT) and waits
// for the agent's ack. Its stderr copy uses a DIFFERENT prefix
// (`runner-egress-diag`), so the host can never read a relayed copy by mistake.
//
// Channel protocol (one request per connection, newline-separated):
//   - marker lines, then EOF → the agent validates and prints each line, then
//     acks `ok`. A runner's `<id>.done=1` line (sent only once every probe,
//     child processes included, has settled) marks it finished.
//   - `GET <id>.<probe>` → the agent answers the value it holds, or `unknown`
//     (runner 2 learns runner 1's listener address this way).
// ---------------------------------------------------------------------------
const RUNNER_EGRESS_TAG = "RUNNER_EGRESS_1547";
/** Stub path runner 1 dials DIRECTLY — its hit count must stay 0. */
const RUNNER_EGRESS_DIRECT_PATH = "/runner-egress-1547/direct";
/** Stub path the agent dials (it may) — proves the counter and the route work. */
const RUNNER_EGRESS_CONTROL_PATH = "/runner-egress-1547/control";
const RUNNER_EGRESS_CONTROL_URL = `http://${aliasIp}:${platformPort}${RUNNER_EGRESS_CONTROL_PATH}`;
/** The mcp-server package every probe integration references (bundle served by the stub). */
const RUNNER_EGRESS_SERVER_PACKAGE = "@smoke/runner-egress-probe-server";
const RUNNER_EGRESS_BUNDLE_PATH = `/internal/mcp-server-bundle/${RUNNER_EGRESS_SERVER_PACKAGE}`;
/** The `delivery.http` integration whose credential the stub serves (MITM runner). */
const RUNNER_EGRESS_MITM_INTEGRATION = "@smoke/runner-egress-mitm";
const RUNNER_EGRESS_CREDENTIALS_PATH = `/internal/integration-credentials/${RUNNER_EGRESS_MITM_INTEGRATION}`;
/** Loopback port of the agent's report channel. */
const RUNNER_EGRESS_DONE_PORT = 18547;
/**
 * Reporter ids, in spawn order (the sidecar boots specs sequentially):
 *   r1   plain-CONNECT runner allowed https://example.com (the #1458 probes)
 *   r2   plain-CONNECT runner allowed https://example.org only, opted into the
 *        workspace — the cross-runner attribution probe and the positive
 *        `workspace` group control
 *   mitm `delivery.http` runner (MITM listener, header injected) allowed
 *        https://example.com/**
 */
const RUNNER_EGRESS_IDS = ["r1", "r2", "mitm"] as const;
type RunnerEgressId = (typeof RUNNER_EGRESS_IDS)[number];
/**
 * Guest-side ports the sidecar pins — `FirecrackerOrchestrator.createSidecar`
 * passes `port: "8080"` / `forwardProxyPort: "8081"`, asserted against the
 * captured sidecar env below so a change there cannot silently point the
 * probes (and the listener-set assertion) at dead ports.
 */
const GUEST_SIDECAR_PORT = 8080;
const GUEST_FORWARD_PROXY_PORT = 8081;
/** The transparent plane's splicers (`startTransparentEgressPlane` defaults). */
const GUEST_TRANSPARENT_TLS_PORT = 443;
const GUEST_TRANSPARENT_HTTP_PORT = 80;
/** The `workspace` group (Dockerfile.rootfs, runner-exec.c WORKSPACE_GID). */
const GUEST_WORKSPACE_GID = 1003;

/**
 * Helpers shared by both probe programs. Plain JS inside String.raw (so the
 * `\r\n` escapes reach the guest verbatim): no backticks, no `${` in the body.
 * Each program imports `net` and `tls` itself. `clean` keeps an observation to
 * one token the host regex can capture (no quotes, braces or spaces).
 */
const RUNNER_EGRESS_HELPERS_JS = String.raw`
const TAG = ${JSON.stringify(RUNNER_EGRESS_TAG)};
const FETCH_TIMEOUT_MS = ${RUNNER_EGRESS_FETCH_TIMEOUT_MS};
const clean = (value, max) =>
  String(value).replace(/[^A-Za-z0-9_.:,\/-]/g, "_").slice(0, max || 80);
const errorOf = (err) => "error:" + ((err && (err.code || err.name)) || "unknown");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// One raw TCP exchange: connect, write, settle on the first response line,
// an error, a close or the timeout — whichever comes first.
function exchange(host, port, payload, timeoutMs) {
  return new Promise((resolve) => {
    let connected = false;
    let data = "";
    let settled = false;
    let timer;
    const socket = net.connect({ host, port });
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ connected, line: data.split("\r\n")[0], error });
    };
    timer = setTimeout(() => settle("timeout"), timeoutMs);
    socket.on("connect", () => {
      connected = true;
      socket.write(payload);
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
      if (data.includes("\r\n")) settle(undefined);
    });
    socket.on("error", (err) => settle(errorOf(err)));
    socket.on("close", () => settle(connected ? "closed" : "closed-before-connect"));
  });
}
// Deliver a report to the agent: write it, half-close, and settle "acked" only
// once the agent answered "ok" — i.e. it read (and printed) every line.
function deliver(host, port, text, timeoutMs) {
  return new Promise((resolve) => {
    let connected = false;
    let data = "";
    let settled = false;
    let timer;
    const socket = net.connect({ host, port });
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    timer = setTimeout(() => settle(connected ? "timeout-after-connect" : "timeout"), timeoutMs);
    socket.on("connect", () => {
      connected = true;
      socket.end(text);
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
      if (data.includes("ok\r\n")) settle("acked");
    });
    socket.on("error", (err) => settle(errorOf(err)));
    socket.on("close", () => settle(connected ? "closed-without-ack" : "closed-before-connect"));
  });
}
// A TLS handshake to host:port presenting servername as SNI. rejectUnauthorized
// is off on purpose: the question is whether ANY TLS server answered.
function tlsHandshake(host, port, servername, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const socket = tls.connect({ host, port, servername, rejectUnauthorized: false });
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    timer = setTimeout(() => settle("timeout"), timeoutMs);
    socket.on("secureConnect", () => settle("secure"));
    socket.on("error", (err) => settle(errorOf(err)));
    socket.on("close", () => settle("closed"));
  });
}
function hostPort(value) {
  const i = String(value).lastIndexOf(":");
  const port = Number(String(value).slice(i + 1));
  return i > 0 && Number.isInteger(port) && port > 0 ? { host: value.slice(0, i), port } : null;
}
const CONNECT_EXAMPLE_COM = "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n";
`;

/**
 * The probe runner: a minimal MCP stdio server (just enough for the
 * sidecar's initialize + tools/list handshake, so the runner stays alive for
 * the whole run instead of being reaped by a failed connect) whose probes run
 * at startup, concurrently with the handshake. `PROBE_ROLE` selects the role
 * probes (every role also runs the identity probes); targets arrive through
 * `spawnEnv` (PROBE_*), the listener through the adapter's HTTPS_PROXY.
 *
 * Denials are only meaningful next to their allowed twin (same route, allowed
 * target, or same target from its owner): an "error" alone could be a broken
 * route rather than a policy refusal.
 */
const RUNNER_PROBE_SERVER_JS = String.raw`
import * as net from "node:net";
import * as tls from "node:tls";
import * as fs from "node:fs";
import { promises as dnsPromises } from "node:dns";
${RUNNER_EGRESS_HELPERS_JS}
const env = process.env;
const ID = env.PROBE_RUNNER_ID || "unknown";
const ROLE = env.PROBE_ROLE || "unknown";
const DONE_PORT = Number(env.PROBE_DONE_PORT);
const PEER_WAIT_MS = Number(env.PROBE_PEER_WAIT_MS);
const CHILD_TIMEOUT_MS = Number(env.PROBE_CHILD_TIMEOUT_MS);
const lines = [];
const line = (probe, value) => TAG + " " + ID + "." + probe + "=" + clean(value);
const mark = (probe, value) => {
  const l = line(probe, value);
  lines.push(l);
  // Diagnostic copy only — deliberately NOT prefixed with TAG.
  console.error("runner-egress-diag " + l.slice(TAG.length + 1));
};
async function probe(name, run) {
  try {
    mark(name, await run());
  } catch (err) {
    mark(name, "crash:" + errorOf(err));
  }
}

// ---- MCP stdio (newline-delimited JSON-RPC) ----
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let nl;
  while ((nl = pending.indexOf("\n")) !== -1) {
    const raw = pending.slice(0, nl).trim();
    pending = pending.slice(nl + 1);
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      continue;
    }
    // Requests only: notifications carry no id, responses no method.
    if (!msg || typeof msg.method !== "string" || msg.id === undefined || msg.id === null) continue;
    if (msg.method === "initialize") {
      reply(msg.id, {
        protocolVersion: (msg.params && msg.params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "runner-egress-probe", version: "1.0.0" },
      });
    } else if (msg.method === "tools/list") {
      reply(msg.id, {
        tools: [
          {
            name: "noop",
            description: "Does nothing.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
    } else if (msg.method === "tools/call") {
      reply(msg.id, { content: [{ type: "text", text: "ok" }] });
    } else if (msg.method === "ping") {
      reply(msg.id, {});
    } else {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
    }
  }
});

// ---- agent channel ----
async function deliverToAgent(text) {
  const deadline = Date.now() + PEER_WAIT_MS;
  let last = "never-tried";
  while (Date.now() < deadline) {
    last = await deliver("127.0.0.1", DONE_PORT, text, 5000);
    if (last === "acked") return last;
    await sleep(1000);
  }
  return last;
}
async function askAgent(key) {
  const deadline = Date.now() + PEER_WAIT_MS;
  while (Date.now() < deadline) {
    const r = await exchange("127.0.0.1", DONE_PORT, "GET " + key + "\r\n", 5000);
    if (r.line && r.line !== "unknown") return r.line;
    await sleep(1000);
  }
  return undefined;
}

// ---- probes ----
async function fetchStatus(url, init) {
  try {
    const base = { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
    const res = await fetch(url, Object.assign(base, init));
    await res.arrayBuffer().catch(() => {});
    return String(res.status);
  } catch (err) {
    return errorOf(err);
  }
}
const viaProxy = (proxy, url, init) =>
  proxy ? fetchStatus(url, Object.assign({ proxy }, init || {})) : "no-proxy-env";
// A child whose env carries ONLY PATH/HOME/PROBE_*: no proxy variable (unless
// PROBE_PROXY is passed explicitly) and no CA variable. Without a proxy its
// only way out is the transparent plane (DNS -> 127.0.0.1 -> SNI splicer);
// with one it trusts nothing but the public roots.
const CHILD_FETCH =
  "const p=process.env.PROBE_PROXY;" +
  "fetch(process.env.PROBE_URL,Object.assign({redirect:'manual'," +
  "signal:AbortSignal.timeout(Number(process.env.PROBE_TIMEOUT_MS))},p?{proxy:p}:{}))" +
  ".then(r=>console.log(String(r.status))," +
  "e=>console.log('error:'+((e&&(e.code||e.name))||'unknown')))" +
  ".finally(()=>setTimeout(()=>process.exit(0),50))";
async function childFetch(url, proxy) {
  const childEnv = {
    PATH: env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: env.HOME || "/tmp",
    PROBE_URL: url,
    PROBE_TIMEOUT_MS: String(FETCH_TIMEOUT_MS),
  };
  if (proxy) childEnv.PROBE_PROXY = proxy;
  const child = Bun.spawn(["bun", "-e", CHILD_FETCH], {
    env: childEnv,
    stdout: "pipe",
    stderr: "ignore",
  });
  const killer = setTimeout(() => child.kill(), CHILD_TIMEOUT_MS);
  const out = await new Response(child.stdout).text();
  await child.exited;
  clearTimeout(killer);
  return out.trim().split("\n").pop() || "error:no-output";
}
const octal = (mode) => (mode & 0o777).toString(8).padStart(3, "0");

// Every role: who am I, what is my HOME, what does my umask produce, and can I
// read my siblings' homes.
async function identityProbes() {
  const uid = process.getuid();
  mark("uid", uid);
  mark("gid", process.getgid());
  mark("egid", process.getegid());
  await probe("groups", () => {
    const groups = Array.from(new Set(process.getgroups())).sort((a, b) => a - b);
    return groups.length > 0 ? groups.join(",") : "none";
  });
  const home = env.HOME || "";
  mark("home", home || "unset");
  await probe("home-stat", () => {
    const st = fs.statSync(home);
    return octal(st.mode) + ":" + st.uid;
  });
  await probe("home-readable", () => {
    fs.readdirSync(home);
    return "yes";
  });
  await probe("umask", () => octal(process.umask()));
  await probe("umask-file", () => {
    const path = home + "/.smoke-umask-file";
    fs.rmSync(path, { force: true });
    fs.writeFileSync(path, "x", { mode: 0o666 });
    const mode = octal(fs.statSync(path).mode);
    fs.rmSync(path, { force: true });
    return mode;
  });
  await probe("umask-dir", () => {
    const path = home + "/.smoke-umask-dir";
    fs.rmSync(path, { recursive: true, force: true });
    fs.mkdirSync(path, { mode: 0o777 });
    const mode = octal(fs.statSync(path).mode);
    fs.rmSync(path, { recursive: true, force: true });
    return mode;
  });
  await probe("foreign-homes", () => {
    const first = Number(env.PROBE_UID_FIRST);
    const count = Number(env.PROBE_UID_COUNT);
    let existing = 0;
    let readable = 0;
    for (let i = 0; i < count; i++) {
      if (first + i === uid) continue;
      const dir = "/home/runner" + i;
      try {
        fs.statSync(dir);
      } catch {
        continue;
      }
      existing++;
      try {
        fs.readdirSync(dir);
        readable++;
      } catch {}
    }
    return readable + "/" + existing;
  });
}

// r1 — plain CONNECT, allowed https://example.com.
function connectRoleProbes(proxy) {
  return Promise.all([
    probe("direct-platform", async () => {
      const r = await exchange(
        env.PROBE_PLATFORM_HOST,
        Number(env.PROBE_PLATFORM_PORT),
        "GET " + env.PROBE_DIRECT_PATH + " HTTP/1.1\r\nHost: platform\r\nConnection: close\r\n\r\n",
        5000,
      );
      return r.connected ? "connected:" + r.line : r.error;
    }),
    probe("proxy-allowed", () => viaProxy(proxy, "https://example.com/")),
    probe("proxy-denied", () => viaProxy(proxy, "https://example.org/")),
    probe("transparent-allowed", () => childFetch("https://example.com/")),
    probe("transparent-denied", () => childFetch("https://example.org/")),
    probe("transparent-tls", () =>
      tlsHandshake("127.0.0.1", ${GUEST_TRANSPARENT_TLS_PORT}, "example.com", FETCH_TIMEOUT_MS),
    ),
    probe("dns", async () => {
      const found = await dnsPromises.lookup("example.com", { all: true, family: 4 });
      return found.map((a) => a.address).join(",") || "empty";
    }),
    probe("agent-proxy", async () => {
      const port = Number(env.PROBE_AGENT_PROXY_PORT);
      const r = await exchange("127.0.0.1", port, CONNECT_EXAMPLE_COM, 8000);
      return r.line || r.error;
    }),
  ]);
}

// r2 — plain CONNECT, allowed https://example.org only; tries r1's listener.
function crossRoleProbes(proxy) {
  mark("workspace-env", env.APPSTRATE_WORKSPACE || "unset");
  return Promise.all([
    probe("proxy-allowed", () => viaProxy(proxy, "https://example.org/")),
    probe("proxy-denied", () => viaProxy(proxy, "https://example.com/")),
    probe("peer-listener", async () => {
      const peer = await askAgent(env.PROBE_PEER_ID + ".proxy-env");
      mark("peer-address", peer || "unknown");
      const target = peer ? hostPort(peer) : null;
      if (!target) return "no-peer-address";
      const r = await exchange(target.host, target.port, CONNECT_EXAMPLE_COM, 8000);
      return r.line || r.error;
    }),
  ]);
}

// mitm — delivery.http: MITM listener, run CA handed over by the adapter.
async function mitmRoleProbes(proxy) {
  const caPath = env.NODE_EXTRA_CA_CERTS || "";
  let caPem = null;
  await probe("ca-readable", () => {
    if (!caPath) return "missing-env";
    caPem = fs.readFileSync(caPath, "utf8");
    return "bytes:" + caPem.length;
  });
  const trustRunCa = caPem ? { tls: { ca: caPem } } : {};
  await Promise.all([
    probe("mitm-allowed", () => viaProxy(proxy, "https://example.com/", trustRunCa)),
    probe("mitm-denied", () => viaProxy(proxy, "https://example.org/", trustRunCa)),
    // Same listener, public roots only: a TLS-terminating listener presents a
    // leaf signed by the run CA, which must NOT verify — a blind tunnel would.
    probe("mitm-untrusted", () =>
      proxy ? childFetch("https://example.com/", proxy) : "no-proxy-env",
    ),
  ]);
}

async function main() {
  const proxy = env.HTTPS_PROXY || "";
  const proxyHostPort = proxy ? proxy.replace(/^[a-z]+:\/\//, "").replace(/\/+$/, "") : "missing";
  mark("proxy-env", proxyHostPort);
  // Early hello: a peer (and the agent's listener probes) needs this
  // listener's address before this runner's probes finish.
  const hello = deliverToAgent(line("proxy-env", proxyHostPort) + "\n" + line("hello", "1") + "\n");
  const roleProbes =
    ROLE === "connect"
      ? connectRoleProbes(proxy)
      : ROLE === "cross"
        ? crossRoleProbes(proxy)
        : ROLE === "mitm"
          ? mitmRoleProbes(proxy)
          : Promise.resolve(mark("role", "unknown:" + ROLE));
  await Promise.all([identityProbes(), roleProbes, hello]);
  // Every probe has settled (child processes included): report, then done.
  mark("done", "1");
  const delivered = await deliverToAgent(lines.join("\n") + "\n");
  console.error("runner-egress-diag " + ID + ".delivery=" + delivered);
}
main().catch((err) => console.error("runner-egress-diag " + ID + ".main=crash:" + errorOf(err)));
`;

/**
 * The agent side of VM4 (`bun -e`, uid 1001). Before the runners report: the
 * two controls that make runner 1's refusals discriminating (the stub counter
 * path, and a 200 from its own forward proxy for the very CONNECT runner 1
 * must be refused). It prints every runner line it receives (validated) and,
 * once all runners are done (bounded wait), probes as the agent: its forward
 * proxy AFTER the runners' attribution is live, the runners' own listeners,
 * the transparent plane, and the kernel's LISTEN socket table.
 */
const RUNNER_EGRESS_AGENT_JS = String.raw`
const net = await import("node:net");
const tls = await import("node:tls");
const { readFile } = await import("node:fs/promises");
${RUNNER_EGRESS_HELPERS_JS}
const mark = (probe, value, max) => console.log(TAG + " agent." + probe + "=" + clean(value, max));
const EXPECTED = ${JSON.stringify(RUNNER_EGRESS_IDS)};
const LINE_RE = /^${RUNNER_EGRESS_TAG} ([a-z0-9]+)\.([a-z0-9-]+)=([A-Za-z0-9_.:,\/-]+)$/;
const reported = new Map();
const done = new Set();
let finish;
const runnersDone = new Promise((resolve) => {
  finish = resolve;
});
const onLine = (socket, state, text) => {
  if (text.startsWith("GET ")) {
    state.replied = true;
    socket.end((reported.get(text.slice(4).trim()) || "unknown") + "\r\n");
    return;
  }
  const m = LINE_RE.exec(text);
  if (!m || !EXPECTED.includes(m[1])) return;
  // The console is the host's evidence: print the runner's line verbatim.
  console.log(text);
  const key = m[1] + "." + m[2];
  if (!reported.has(key)) reported.set(key, m[3]);
  if (m[2] === "done") {
    done.add(m[1]);
    if (EXPECTED.every((id) => done.has(id))) finish("signalled");
  }
};
// Listen FIRST: runners report as soon as they start.
const server = net.createServer((socket) => {
  const state = { buf: "", replied: false };
  socket.on("data", (chunk) => {
    state.buf += chunk.toString("latin1");
    let nl;
    while (!state.replied && (nl = state.buf.indexOf("\n")) !== -1) {
      const text = state.buf.slice(0, nl).replace(/\r$/, "");
      state.buf = state.buf.slice(nl + 1);
      onLine(socket, state, text);
    }
  });
  socket.on("end", () => {
    if (state.replied) return;
    if (state.buf) onLine(socket, state, state.buf.replace(/\r$/, ""));
    if (state.replied) return;
    state.replied = true;
    socket.end("ok\r\n");
  });
  socket.on("error", () => socket.destroy());
});
server.on("error", (err) => finish("listen-" + errorOf(err)));
server.listen(${RUNNER_EGRESS_DONE_PORT}, "127.0.0.1");
const waitTimer = setTimeout(
  () => finish("timeout:missing=" + EXPECTED.filter((id) => !done.has(id)).join(",")),
  ${RUNNER_EGRESS_AGENT_WAIT_MS},
);

// Every LISTEN socket in the kernel's table, as uid/address:port.
async function listenSockets() {
  const out = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const v6 = file.endsWith("6");
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      out.push("unreadable-" + (v6 ? "tcp6" : "tcp"));
      continue;
    }
    for (const row of text.split("\n").slice(1)) {
      const f = row.trim().split(/\s+/);
      if (f.length < 8 || f[3] !== "0A") continue;
      const local = f[1].split(":");
      const port = parseInt(local[1], 16);
      const addr = v6
        ? "v6-" + local[0].toLowerCase()
        : [6, 4, 2, 0].map((i) => parseInt(local[0].slice(i, i + 2), 16)).join(".");
      out.push(f[7] + "/" + addr + ":" + port);
    }
  }
  return out.length > 0 ? out.join(",") : "none";
}

try {
  const controlUrl = ${JSON.stringify(RUNNER_EGRESS_CONTROL_URL)};
  const res = await fetch(controlUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  mark("platform-control", res.status);
} catch (err) {
  mark("platform-control", errorOf(err));
}
// The sidecar cold-starts in parallel with the agent: retry until its proxy answers.
let proxyControl = "unknown";
for (let i = 0; i < 60; i++) {
  const r = await exchange("127.0.0.1", ${GUEST_FORWARD_PROXY_PORT}, CONNECT_EXAMPLE_COM, 8000);
  proxyControl = r.line || r.error;
  if (r.line) break;
  await sleep(500);
}
mark("proxy-control", proxyControl);

mark("runners-done", await runnersDone);
clearTimeout(waitTimer);

// (1) The forward proxy still admits the agent once runner attribution is live.
let proxyAfter = "unknown";
for (let i = 0; i < 5; i++) {
  const r = await exchange("127.0.0.1", ${GUEST_FORWARD_PROXY_PORT}, CONNECT_EXAMPLE_COM, 8000);
  proxyAfter = r.line || r.error;
  if (r.line) break;
  await sleep(500);
}
mark("proxy-after", proxyAfter);
// (2) A runner's listener refuses the agent (both listener kinds).
for (const id of ["r1", "mitm"]) {
  const target = hostPort(reported.get(id + ".proxy-env") || "");
  if (!target) {
    mark("via-" + id + "-listener", "no-proxy-env");
    continue;
  }
  const r = await exchange(target.host, target.port, CONNECT_EXAMPLE_COM, 8000);
  mark("via-" + id + "-listener", r.line || r.error);
}
// (3) The transparent plane refuses the agent.
mark(
  "transparent-tls",
  await tlsHandshake("127.0.0.1", ${GUEST_TRANSPARENT_TLS_PORT}, "example.com", FETCH_TIMEOUT_MS),
);
// (6) Every LISTEN socket, taken last (after every probe that could lazily open one).
mark("listen", await listenSockets(), 2000);
server.close();
await sleep(1000);
process.exit(0);
`;

/** Env every probe runner gets; roles add their own targets. */
function runnerProbeEnv(id: RunnerEgressId, role: string): Record<string, string> {
  return {
    PROBE_RUNNER_ID: id,
    PROBE_ROLE: role,
    PROBE_DONE_PORT: String(RUNNER_EGRESS_DONE_PORT),
    PROBE_PEER_WAIT_MS: String(RUNNER_EGRESS_PEER_WAIT_MS),
    PROBE_CHILD_TIMEOUT_MS: String(RUNNER_EGRESS_CHILD_TIMEOUT_MS),
    PROBE_UID_FIRST: String(GUEST_RUNNER_UID_FIRST),
    PROBE_UID_COUNT: String(GUEST_RUNNER_UID_COUNT),
  };
}

/** A local integration running the probe bundle (the stub serves one bundle for all). */
function runnerProbeIntegration(
  integrationId: string,
  namespace: string,
  extra: Omit<IntegrationSpawnSpec, "integrationId" | "namespace" | "sourceKind" | "manifest">,
): IntegrationSpawnSpec {
  return {
    integrationId,
    namespace,
    sourceKind: "local",
    manifest: {
      name: integrationId,
      version: "1.0.0",
      server: { type: "bun", entry_point: "server.js", packageId: RUNNER_EGRESS_SERVER_PACKAGE },
    },
    ...extra,
  };
}

/** The MITM runner's header credential (fake; example.com ignores it). */
const RUNNER_EGRESS_MITM_AUTH_KEY = "smoke_key";
const RUNNER_EGRESS_MITM_HEADER = "X-Smoke-Credential";
const RUNNER_EGRESS_MITM_VALUE = "smoke-mitm-credential-0C0FFEE";
const RUNNER_EGRESS_MITM_URIS = ["https://example.com/**"];

/**
 * The three integrations the fourth VM's sidecar boots, in spawn order. r1 and
 * r2 carry NO credentials (no delivery.http, no api_call ⇒ plain-CONNECT
 * listener); mitm declares `delivery.http`, so the sidecar mints the run CA,
 * fetches its credential from the stub and mounts a MITM listener instead.
 */
const RUNNER_EGRESS_INTEGRATIONS: IntegrationSpawnSpec[] = [
  runnerProbeIntegration("@smoke/runner-egress-probe", "runner_egress_probe", {
    spawnEnv: {
      ...runnerProbeEnv("r1", "connect"),
      PROBE_PLATFORM_HOST: aliasIp,
      PROBE_PLATFORM_PORT: String(platformPort),
      PROBE_DIRECT_PATH: RUNNER_EGRESS_DIRECT_PATH,
      PROBE_AGENT_PROXY_PORT: String(GUEST_FORWARD_PROXY_PORT),
    },
    egress: { authorizedUris: ["https://example.com"], allowAllUris: false },
  }),
  runnerProbeIntegration("@smoke/runner-egress-cross", "runner_egress_cross", {
    spawnEnv: { ...runnerProbeEnv("r2", "cross"), PROBE_PEER_ID: "r1" },
    egress: { authorizedUris: ["https://example.org"], allowAllUris: false },
    // Opt-in: the positive control for the `workspace` group (r1/mitm must lack it).
    workspaceMount: { mount: "/workspace", access: "rw" },
  }),
  runnerProbeIntegration(RUNNER_EGRESS_MITM_INTEGRATION, "runner_egress_mitm", {
    spawnEnv: runnerProbeEnv("mitm", "mitm"),
    egress: { authorizedUris: RUNNER_EGRESS_MITM_URIS, allowAllUris: false },
    httpDeliveryAuths: {
      [RUNNER_EGRESS_MITM_AUTH_KEY]: {
        authType: "api_key",
        headerName: RUNNER_EGRESS_MITM_HEADER,
        headerPrefix: "",
        value: RUNNER_EGRESS_MITM_VALUE,
        allowServerOverride: false,
        authorizedUris: RUNNER_EGRESS_MITM_URIS,
        expiresAtEpochMs: null,
      },
    },
  }),
];

/**
 * What the stub answers on `GET /internal/integration-credentials/<mitm id>` —
 * the platform's snake_case wire (normalizeIntegrationCredentialsWire in
 * runtime-pi/sidecar/integration-credentials-source.ts).
 */
const RUNNER_EGRESS_MITM_CREDENTIALS = {
  auths: [
    {
      auth_key: RUNNER_EGRESS_MITM_AUTH_KEY,
      auth_type: "api_key",
      fields: { api_key: RUNNER_EGRESS_MITM_VALUE },
      authorized_uris: RUNNER_EGRESS_MITM_URIS,
    },
  ],
  delivery_plans: {
    [RUNNER_EGRESS_MITM_AUTH_KEY]: {
      header_name: RUNNER_EGRESS_MITM_HEADER,
      header_prefix: "",
      value: RUNNER_EGRESS_MITM_VALUE,
      allow_server_override: false,
    },
  },
  expires_at_epoch_ms: { [RUNNER_EGRESS_MITM_AUTH_KEY]: null },
};

/** The mcp-server bundle the stub serves on RUNNER_EGRESS_BUNDLE_PATH. */
const runnerProbeBundle = zipSync({
  "server.js": new TextEncoder().encode(RUNNER_PROBE_SERVER_JS),
});

/** Stub counters for VM4 (see the platform stub below). */
const runnerEgressHits = { bundle: 0, direct: 0, control: 0, credentials: 0 };

/**
 * A marker as the AGENT printed it. The runners' stderr copies carry another
 * prefix (`runner-egress-diag`), so this can only match an agent-printed line.
 */
function runnerEgressMarker(log: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${RUNNER_EGRESS_TAG} ${escaped}=([A-Za-z0-9_.:,/-]+)`).exec(log)?.[1];
}

/** Every VM4 probe verdict, taken host-side from the raw observations. */
function assertRunnerEgress(log: string): void {
  const need = (key: string): string => {
    const value = runnerEgressMarker(log, key);
    if (value === undefined) {
      fail(`#1547 probe '${key}' never reported on the console (agent-printed lines only)`);
    }
    return value;
  };
  const isSuccess = (v: string) => /^[23]\d\d$/.test(v);
  const isRefusal = (v: string) => v.startsWith("error:") || /^[45]\d\d$/.test(v);
  /** A raw CONNECT exchange: the status it got, if any. */
  const connectStatus = (v: string) => /^HTTP\/1\.[01]_(\d{3})/.exec(v)?.[1];
  /** Refused = a non-200 status, or no tunnel at all. */
  const isConnectRefusal = (v: string) => {
    const status = connectStatus(v);
    return status !== undefined ? status !== "200" : /^(error:|timeout|closed)/.test(v);
  };
  const isConnect200 = (v: string) => connectStatus(v) === "200";

  // --- 0. Plumbing: the runners started and reported, the stub saw the fetches.
  if (runnerEgressHits.bundle === 0) {
    fail(
      "the sidecar never fetched the probe mcp-server bundle — INTEGRATIONS_TO_SPAWN_JSON did " +
        "not reach it, or the integration boot failed before the fetch",
    );
  }
  const done = need("agent.runners-done");
  if (done !== "signalled") {
    fail(
      `not every probe runner delivered its final report (${done}) — it did not start, hung, ` +
        "or was reaped; see the sidecar's 'integration' and 'runner-egress-diag' lines above",
    );
  }

  // --- 5. Identity hygiene, per runner.
  const lastUid = GUEST_RUNNER_UID_FIRST + GUEST_RUNNER_UID_COUNT - 1;
  const uids = new Map<RunnerEgressId, number>();
  const listenerPorts = new Map<RunnerEgressId, number>();
  for (const id of RUNNER_EGRESS_IDS) {
    const uid = Number(need(`${id}.uid`));
    if (!(uid >= GUEST_RUNNER_UID_FIRST && uid <= lastUid)) {
      fail(
        `runner ${id} runs as uid ${uid}, outside the pool ${GUEST_RUNNER_UID_FIRST}-${lastUid} — ` +
          "the setuid wrapper did not drop it onto a runner uid",
      );
    }
    uids.set(id, uid);
    for (const probe of ["gid", "egid"]) {
      const gid = need(`${id}.${probe}`);
      if (Number(gid) !== uid) {
        fail(`runner ${id} (uid ${uid}) has ${probe} ${gid} — expected its private group ${uid}`);
      }
    }
    const groups = need(`${id}.groups`);
    const groupSet = new Set(groups === "none" ? [] : groups.split(",").map(Number));
    const allowed = new Set([uid, ...(id === "r2" ? [GUEST_WORKSPACE_GID] : [])]);
    const foreign = [...groupSet].filter((g) => !allowed.has(g));
    if (foreign.length > 0) {
      fail(
        `runner ${id} (uid ${uid}) holds group(s) ${foreign.join(",")} (groups ${groups}) — ` +
          (foreign.includes(GUEST_WORKSPACE_GID)
            ? "the workspace group leaked onto a runner that did not opt into the workspace"
            : "expected only its private group" + (id === "r2" ? " and workspace" : "")),
      );
    }
    if (id === "r2" && !groupSet.has(GUEST_WORKSPACE_GID)) {
      fail(
        `runner r2 opted into the workspace but lacks group ${GUEST_WORKSPACE_GID} (groups ` +
          `${groups}) — the wrapper never got --workspace, and r1/mitm lacking it proves nothing`,
      );
    }
    const expectedHome = `/home/runner${uid - GUEST_RUNNER_UID_FIRST}`;
    const home = need(`${id}.home`);
    if (home !== expectedHome) {
      fail(`runner ${id} (uid ${uid}) has HOME=${home}, expected ${expectedHome}`);
    }
    const homeStat = need(`${id}.home-stat`);
    if (homeStat !== `700:${uid}`) {
      fail(`runner ${id} HOME ${home} is mode:owner ${homeStat}, expected 700:${uid}`);
    }
    const homeReadable = need(`${id}.home-readable`);
    if (homeReadable !== "yes") {
      fail(
        `runner ${id} cannot list its own HOME (${homeReadable}) — the foreign-home check is vacuous`,
      );
    }
    for (const [probe, want] of [
      ["umask", "007"],
      ["umask-file", "660"],
      ["umask-dir", "770"],
    ] as const) {
      const got = need(`${id}.${probe}`);
      if (got !== want) {
        fail(`runner ${id} ${probe} is ${got}, expected ${want} (umask 007: no world bits)`);
      }
    }
    const foreignHomes = need(`${id}.foreign-homes`);
    if (foreignHomes !== `0/${GUEST_RUNNER_UID_COUNT - 1}`) {
      fail(
        `runner ${id} foreign homes readable/existing = ${foreignHomes}, expected ` +
          `0/${GUEST_RUNNER_UID_COUNT - 1} — a sibling's 0700 HOME is readable, or the pool ` +
          "homes are missing",
      );
    }
    const proxyEnv = need(`${id}.proxy-env`);
    const port = Number(/^127\.0\.0\.1:(\d+)$/.exec(proxyEnv)?.[1]);
    if (!Number.isInteger(port) || port <= 0) {
      fail(
        `runner ${id} got HTTPS_PROXY ${proxyEnv}, expected 127.0.0.1:<port> — the sidecar ` +
          "mounted no listener for spec.egress",
      );
    }
    listenerPorts.set(id, port);
  }
  // --- 4a. One uid per runner.
  if (new Set(uids.values()).size !== RUNNER_EGRESS_IDS.length) {
    fail(`runners share a uid (${[...uids].map(([id, u]) => `${id}=${u}`).join(" ")})`);
  }

  // --- r1: no direct egress (a refused attempt AND zero stub hits, next to the
  //     agent's successful control on the same counter).
  const direct = need("r1.direct-platform");
  if (!/^(error:|timeout|closed-before-connect)/.test(direct)) {
    fail(
      `runner's direct TCP to the platform stub was not refused (${direct}) — ` +
        "runner uids keep direct egress",
    );
  }
  if (runnerEgressHits.direct !== 0) {
    fail(
      `platform stub saw ${runnerEgressHits.direct} direct runner hit(s) on ` +
        `${RUNNER_EGRESS_DIRECT_PATH} — runner uids keep direct egress`,
    );
  }
  const control = need("agent.platform-control");
  if (runnerEgressHits.control === 0 || !isSuccess(control)) {
    fail(
      `the agent's control request never reached the stub counter (${control}, ` +
        `${runnerEgressHits.control} hit(s)) — the zero-direct-hit assertion would be vacuous`,
    );
  }

  // --- r1: its CONNECT listener enforces authorized_uris.
  const r1Allowed = need("r1.proxy-allowed");
  if (!isSuccess(r1Allowed)) {
    fail(
      `runner r1 could not reach https://example.com through its CONNECT listener ` +
        `(${r1Allowed}) — allowlisted egress is broken (the guest's sidecar also needs ` +
        "internet access), and every refusal through that listener below would be vacuous",
    );
  }
  const r1Denied = need("r1.proxy-denied");
  if (!isRefusal(r1Denied)) {
    fail(`runner r1 reached https://example.org through its CONNECT listener (${r1Denied})`);
  }

  // --- r1: transparent plane for proxy-unaware clients, same policy.
  const plainAllowed = need("r1.transparent-allowed");
  if (!isSuccess(plainAllowed)) {
    fail(
      `proxy-unaware runner client could not reach https://example.com (${plainAllowed}) — ` +
        "transparent plane (DNS -> 127.0.0.1 -> SNI splicer) is broken",
    );
  }
  const plainDenied = need("r1.transparent-denied");
  if (!isRefusal(plainDenied)) {
    fail(
      `proxy-unaware runner client reached https://example.org (${plainDenied}) — ` +
        "the transparent plane ignores the allowlist",
    );
  }
  const dns = need("r1.dns");
  if (dns !== "127.0.0.1") {
    fail(
      `runner resolved example.com to ${dns}, expected 127.0.0.1 — ` +
        "runner DNS is not redirected to the sidecar's responder",
    );
  }

  // --- 3. The transparent plane admits runner r1 and refuses the agent (same
  //        TLS probe, same SNI, two uids).
  const r1Tls = need("r1.transparent-tls");
  if (r1Tls !== "secure") {
    fail(
      `runner r1's TLS handshake to 127.0.0.1:${GUEST_TRANSPARENT_TLS_PORT} (SNI example.com) ` +
        `got ${r1Tls} — the agent refusal below would be vacuous`,
    );
  }
  const agentTls = need("agent.transparent-tls");
  if (agentTls === "secure" || !/^(error:|timeout|closed)/.test(agentTls)) {
    fail(
      `the agent completed a TLS handshake through the transparent plane (${agentTls}) — ` +
        "the splicer serves non-runner peers",
    );
  }

  // --- r1 vs the agent's forward proxy: refused, while the agent itself is
  //     admitted before AND after (1) the runners' attribution went live.
  const agentProxyControl = need("agent.proxy-control");
  if (!isConnect200(agentProxyControl)) {
    fail(
      `the agent's own CONNECT through its forward proxy got ${agentProxyControl}, ` +
        "expected 200 — the runner refusal below would be vacuous",
    );
  }
  const runnerViaAgentProxy = need("r1.agent-proxy");
  const status = connectStatus(runnerViaAgentProxy);
  if (status === undefined || status === "200") {
    fail(
      `runner's CONNECT through the agent's forward proxy got ${runnerViaAgentProxy} — ` +
        "expected the proxy to answer with a refusal status",
    );
  }
  const agentProxyAfter = need("agent.proxy-after");
  if (!isConnect200(agentProxyAfter)) {
    fail(
      `once the runners existed, the agent's own CONNECT through its forward proxy got ` +
        `${agentProxyAfter}, expected 200 — the swapped-in runner attribution locks the agent out`,
    );
  }

  // --- 2. A runner's listener refuses the agent, next to its owner's success.
  const viaR1 = need("agent.via-r1-listener");
  if (!isConnectRefusal(viaR1)) {
    fail(
      `the agent's CONNECT example.com through runner r1's listener got ${viaR1} while r1's ` +
        `own got ${r1Allowed} — the listener does not attribute its peers`,
    );
  }

  // --- 4b. Cross-runner attribution on the real kernel: r2 through r1's
  //         listener is refused while r1 through it succeeded; r2's own
  //         listener works for ITS target.
  const r2Allowed = need("r2.proxy-allowed");
  if (!isSuccess(r2Allowed)) {
    fail(
      `runner r2 could not reach https://example.org through its own listener (${r2Allowed}) ` +
        "— its refusal through r1's listener would be vacuous",
    );
  }
  const r2Denied = need("r2.proxy-denied");
  if (!isRefusal(r2Denied)) {
    fail(`runner r2 reached https://example.com through its own listener (${r2Denied})`);
  }
  const peerAddress = need("r2.peer-address");
  const r1ProxyEnv = need("r1.proxy-env");
  if (peerAddress !== r1ProxyEnv) {
    fail(`runner r2 dialed ${peerAddress}, not runner r1's listener ${r1ProxyEnv}`);
  }
  const r2ViaR1 = need("r2.peer-listener");
  if (!isConnectRefusal(r2ViaR1)) {
    fail(
      `runner r2 (uid ${uids.get("r2")}) got ${r2ViaR1} for CONNECT example.com through runner ` +
        `r1's listener, while r1 (uid ${uids.get("r1")}) got ${r1Allowed} — a listener serves ` +
        "a sibling runner under its owner's policy",
    );
  }

  // --- 6a. The MITM runner: credential fetched, CA readable on its uid, TLS
  //         terminated by the listener (the run CA's leaf does not verify on
  //         public roots), allowlist enforced.
  if (runnerEgressHits.credentials === 0) {
    fail(
      "the sidecar never fetched the MITM integration's credentials — delivery.http did not " +
        "reach it, so no MITM listener can have been mounted",
    );
  }
  const caReadable = need("mitm.ca-readable");
  if (!/^bytes:[1-9]\d*$/.test(caReadable)) {
    fail(
      `MITM runner could not read the run CA (${caReadable}) — ` +
        (caReadable === "missing-env"
          ? "no CA env: the sidecar mounted a plain CONNECT listener instead of MITM (run-CA " +
            "mint failed — is openssl in the guest rootfs?)"
          : "the CA dir/file is not readable on the runner's uid"),
    );
  }
  const mitmAllowed = need("mitm.mitm-allowed");
  if (!isSuccess(mitmAllowed)) {
    fail(
      `MITM runner could not fetch https://example.com through its MITM listener ` +
        `(${mitmAllowed}) — MITM egress is broken on the runner's uid`,
    );
  }
  const mitmUntrusted = need("mitm.mitm-untrusted");
  if (!/^error:.*(CERT|SIGNATURE|ISSUER|SELF_SIGNED|UNTRUSTED)/i.test(mitmUntrusted)) {
    fail(
      `a public-roots-only client through the MITM listener got ${mitmUntrusted}, expected a ` +
        "certificate verification error — the listener did not terminate TLS with the run CA",
    );
  }
  const mitmDenied = need("mitm.mitm-denied");
  if (!isRefusal(mitmDenied)) {
    fail(`MITM runner reached https://example.org through its MITM listener (${mitmDenied})`);
  }
  const viaMitm = need("agent.via-mitm-listener");
  if (!isConnectRefusal(viaMitm)) {
    fail(
      `the agent's CONNECT example.com through the MITM runner's listener got ${viaMitm} ` +
        "— the MITM listener does not attribute its peers",
    );
  }

  // --- 6b. The sidecar's LISTEN sockets are exactly the known listeners: an
  //         extra one is a reachable inner server (e.g. a MITM per-SNI TLS
  //         server on TCP); a missing one means the scan is broken.
  const listen = need("agent.listen");
  const entries = listen.split(",");
  if (entries.includes("unreadable-tcp") || listen === "none") {
    fail(`the agent could not scan /proc/net/tcp (${listen})`);
  }
  const sidecarPorts = new Set<number>();
  for (const entry of entries) {
    if (entry === "unreadable-tcp6") continue; // guest kernel without IPv6
    const m = /^(\d+)\/(.+):(\d+)$/.exec(entry);
    if (!m) fail(`unparseable LISTEN entry '${entry}' in ${listen}`);
    if (m[1] === GUEST_SIDECAR_UID) sidecarPorts.add(Number(m[3]));
  }
  const expectedListeners = new Map<number, string>([
    [GUEST_SIDECAR_PORT, "sidecar"],
    [GUEST_FORWARD_PROXY_PORT, "agent forward proxy"],
    [GUEST_TRANSPARENT_TLS_PORT, "transparent TLS splicer"],
    [GUEST_TRANSPARENT_HTTP_PORT, "transparent HTTP splicer"],
    ...[...listenerPorts].map(([id, port]) => [port, `${id} listener`] as [number, string]),
  ]);
  const extra = [...sidecarPorts].filter((p) => !expectedListeners.has(p));
  if (extra.length > 0) {
    fail(
      `the sidecar (uid ${GUEST_SIDECAR_UID}) listens on unexpected TCP port(s) ` +
        `${extra.join(",")} — an inner server is reachable over TCP (LISTEN table: ${listen})`,
    );
  }
  const missing = [...expectedListeners].filter(([p]) => !sidecarPorts.has(p));
  if (missing.length > 0) {
    fail(
      `the LISTEN scan misses ${missing.map(([p, what]) => `${p} (${what})`).join(", ")} — ` +
        `the scan (or the uid ${GUEST_SIDECAR_UID} filter) is broken (LISTEN table: ${listen})`,
    );
  }

  console.log(
    "    runner egress ok: 3 runners on distinct pool uids with private groups/HOME/umask, " +
      "no direct egress, per-runner allowlists via CONNECT + MITM + transparent plane, " +
      "listeners and splicer refuse the agent and siblings, agent keeps its forward proxy, " +
      "no inner server on TCP",
  );
}

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
// It also serves VM4: the probe mcp-server bundle the in-guest sidecar
// fetches exactly like the real /internal/mcp-server-bundle route, the MITM
// integration's credential exactly like /internal/integration-credentials
// (the run token is not checked — nothing else is served), and the two
// counter paths of the #1547 direct-egress assertion.
const platformStub = Bun.serve({
  hostname: aliasIp,
  port: platformPort,
  fetch: (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === RUNNER_EGRESS_BUNDLE_PATH) {
      runnerEgressHits.bundle++;
      return new Response(runnerProbeBundle, { headers: { "content-type": "application/zip" } });
    }
    if (pathname === RUNNER_EGRESS_CREDENTIALS_PATH && req.method === "GET") {
      runnerEgressHits.credentials++;
      return Response.json(RUNNER_EGRESS_MITM_CREDENTIALS);
    }
    if (pathname === RUNNER_EGRESS_DIRECT_PATH) runnerEgressHits.direct++;
    if (pathname === RUNNER_EGRESS_CONTROL_PATH) runnerEgressHits.control++;
    return new Response("ok");
  },
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
    // Agent-env key named for a credential: brokered off the drive too,
    // whatever its value.
    await assertConfigDriveOmitsSecret(imagePath, FAKE_MODEL_KEY);
  }

  const exitCode = await withExitTimeout(orch.waitForExit(agent), "VM did not exit within 90s");
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
  // Second minimal VM: non-zero exit-code propagation. Trivial agent — the
  // guest's `exit 42` must round-trip through the nonce-authenticated marker
  // to waitForExit.
  // ---------------------------------------------------------------------
  console.log("==> second microVM (exit-code propagation)");
  const RUN_ID2 = `${RUN_ID}_exit42`;
  // Same smoke-only DI seam as the constructor arg — swapped between runs
  // because the override is per-orchestrator, not per-run.
  Reflect.set(orch, "agentArgvOverride", ["/bin/sh", "-c", "exit 42"]);
  const boundary2 = await orch.createIsolationBoundary(RUN_ID2);
  try {
    const sidecar2 = await orch.createSidecar(RUN_ID2, boundary2, { runToken: FAKE_RUN_TOKEN });
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
    const exitCode2 = await withExitTimeout(
      orch.waitForExit(agent2),
      "second VM did not exit within 90s",
    );
    console.log(`==> second guest exit marker: ${exitCode2}`);
    await dumpConsole(boundary2.id, "vm2");
    if (exitCode2 !== 42) {
      fail(`expected exit marker 42 from the second VM, got ${exitCode2}`);
    }
    await orch.removeWorkload(sidecar2);
    await orch.removeWorkload(agent2);
  } catch (err) {
    await dumpConsole(boundary2.id, "vm2 exception");
    throw err;
  } finally {
    await orch.removeIsolationBoundary(boundary2).catch(() => {});
  }

  // ---------------------------------------------------------------------
  // Third VM (B4): the REAL agent entrypoint — NO argv override, so the
  // supervisor runs the baked default (`launcher.js` → `entrypoint.js`).
  // A minimal agent env (no valid platform sink) makes the
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
    // Minimal env: the entrypoint's parseRuntimeEnv fails fast on the
    // missing APPSTRATE_SINK_* contract.
    const sidecar3 = await orch.createSidecar(RUN_ID3, boundary3, { runToken: FAKE_RUN_TOKEN });
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
    await withExitTimeout(orch.waitForExit(agent3), "third VM did not exit within 90s");
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
    await orch.removeWorkload(sidecar3);
    await orch.removeWorkload(agent3);
  } catch (err) {
    await dumpConsole(boundary3.id, "vm3 exception");
    throw err;
  } finally {
    await orch.removeIsolationBoundary(boundary3).catch(() => {});
  }

  // ---------------------------------------------------------------------
  // Fourth VM (#1547): the REAL in-guest sidecar boots THREE local
  // integrations (specs through the ordinary SidecarLaunchSpec.integrations →
  // INTEGRATIONS_TO_SPAWN_JSON path, bundle and MITM credential fetched from
  // the stub) whose runners are the probe MCP server above in its three
  // roles. The agent argv is the probe counterpart: controls, the runners'
  // reports (printed by the agent), then the agent-side probes. Every verdict
  // is taken here from the console (assertRunnerEgress).
  // ---------------------------------------------------------------------
  console.log("==> fourth microVM (integration runner egress, #1547)");
  const RUN_ID4 = `${RUN_ID}_runneregress`;
  Reflect.set(orch, "agentArgvOverride", ["bun", "-e", RUNNER_EGRESS_AGENT_JS]);
  const boundary4 = await orch.createIsolationBoundary(RUN_ID4);
  try {
    const sidecar4 = await orch.createSidecar(RUN_ID4, boundary4, {
      runToken: FAKE_RUN_TOKEN,
      integrations: RUNNER_EGRESS_INTEGRATIONS,
    });
    // The probes dial the sidecar's ports by number (a runner cannot read the
    // sidecar's env) and the listener-set assertion expects them — pin both to
    // the env the sidecar will boot on. r2's workspace opt-in (the positive
    // `workspace` group control) needs the directory handle the adapter reads.
    const pending = Reflect.get(orch, "pendingSidecarEnv") as Map<string, Record<string, string>>;
    const env4 = pending.get(RUN_ID4) ?? {};
    for (const [key, want] of [
      ["PORT", GUEST_SIDECAR_PORT],
      ["FORWARD_PROXY_PORT", GUEST_FORWARD_PROXY_PORT],
    ] as const) {
      if (env4[key] !== String(want)) {
        fail(`sidecar ${key} is ${env4[key]}, the #1547 probes expect ${want} — update the smoke`);
      }
    }
    if (!/"kind":"directory"/.test(env4.WORKSPACE_HANDLE_JSON ?? "")) {
      fail(
        `sidecar WORKSPACE_HANDLE_JSON is ${env4.WORKSPACE_HANDLE_JSON} — r2's workspace ` +
          "opt-in (the workspace-group control) needs a directory handle",
      );
    }
    const agent4 = await orch.createWorkload(
      {
        runId: RUN_ID4,
        role: "agent",
        image: "unused-by-firecracker",
        env: {},
        resources: { memoryBytes: 512 * 1024 * 1024, nanoCpus: 1_000_000_000 },
      },
      boundary4,
    );
    await orch.startWorkload(agent4);
    const exitCode4 = await withExitTimeout(
      orch.waitForExit(agent4),
      `fourth VM did not exit within ${RUNNER_EGRESS_VM_TIMEOUT_MS / 1000}s`,
      RUNNER_EGRESS_VM_TIMEOUT_MS,
    );
    console.log(`==> fourth guest exit marker: ${exitCode4}`);
    const console4 = await Bun.file(`${boundary4.id}/console.log`)
      .text()
      .catch(() => "");
    await dumpConsole(boundary4.id, "vm4");
    // The tail above is dominated by sidecar logs: surface every probe
    // marker and runner/egress line wherever it sits in the console.
    console.log("---- #1547 probe + runner lines (vm4) ----");
    for (const line of console4.split("\n")) {
      if (
        line.includes(RUNNER_EGRESS_TAG) ||
        line.includes("runner-egress-diag") ||
        line.includes("integration stderr") ||
        line.includes("egress") ||
        line.includes("mitm") ||
        line.includes("MITM") ||
        line.includes("Integration") ||
        line.includes("integration runtime") ||
        line.includes("boot wait")
      ) {
        console.log(line);
      }
    }
    console.log(
      `     stub hits: bundle=${runnerEgressHits.bundle} direct=${runnerEgressHits.direct} ` +
        `control=${runnerEgressHits.control} credentials=${runnerEgressHits.credentials}`,
    );
    console.log("------------------------------");
    if (exitCode4 !== 0) {
      fail(`expected exit marker 0 from the fourth VM, got ${exitCode4} (agent probe failed)`);
    }
    assertRunnerEgress(console4);
    await orch.removeWorkload(sidecar4);
    await orch.removeWorkload(agent4);
  } catch (err) {
    await dumpConsole(boundary4.id, "vm4 exception");
    throw err;
  } finally {
    await orch.removeIsolationBoundary(boundary4).catch(() => {});
  }
} catch (err) {
  await dumpConsole(boundary.id, "vm1 exception");
  throw err;
} finally {
  await platformStub.stop(true);
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
