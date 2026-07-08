// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate-runner` daemon entrypoint (issue #819, phase 1).
 *
 * Runs directly on the KVM host and exposes the local
 * {@link FirecrackerOrchestrator} over the wire protocol in
 * ./protocol.ts, so a CONTAINERIZED platform (which cannot touch
 * /dev/kvm, TAP devices, or nftables) can still drive microVM runs:
 *
 *   platform container ── firecracker backend (HTTP client) ──HTTP──▶ this daemon ──▶ microVMs
 *
 * Start on the host:
 *
 *   FIRECRACKER_RUNNER_TOKEN=… \
 *   FIRECRACKER_RUNNER_PLATFORM_URL=http://<host-ip>:3000 \
 *   bun run firecracker:runner
 *
 * Boot order is deliberate: env → host-hygiene advisory → artifacts →
 * initialize() → orphan sweep → guest-path self-verification → listen. Guest artifacts
 * (kernel + rootfs) are resolved BEFORE initialize() so its existence
 * check passes on a freshly provisioned host that never ran `bun run
 * firecracker:build`. The port only opens after the host firewall and
 * artifacts are proven good, which is what lets /v1/health hardcode
 * `initialized: true`; the net probe (phase 5) then annotates that
 * health with the guest→platform reachability facts.
 */

import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { FirecrackerOrchestrator } from "../orchestrator.ts";
import { createHostExec } from "../host-net.ts";
import { getFirecrackerEnv } from "./host-env.ts";
import { getRunnerEnv, resolveListenConfig } from "./env.ts";
import { createRunnerApp } from "./server.ts";
import { ensureGuestArtifacts } from "./artifacts.ts";
import { warmHostPageCache } from "./readahead.ts";
import { verifyGuestPath, type GuestPathResult } from "./net-probe.ts";
import { checkHostHygiene } from "./host-hygiene.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "./logger.ts";

function fatal(step: string, err: unknown): never {
  logger.error(`appstrate-runner failed to start: ${step}`, { error: getErrorMessage(err) });
  process.exit(1);
}

// Fail fast on malformed configuration BEFORE touching the host: a bad
// CIDR or missing token must be a one-line startup error, not a
// mid-run surprise. Both surfaces are validated — the daemon's own
// (FIRECRACKER_RUNNER_*) and the orchestrator's (FIRECRACKER_*).
let runnerEnv: ReturnType<typeof getRunnerEnv>;
let fcEnv: ReturnType<typeof getFirecrackerEnv>;
try {
  runnerEnv = getRunnerEnv();
  fcEnv = getFirecrackerEnv();
} catch (err) {
  fatal("invalid environment", err);
}

// Host-hygiene advisory (Firecracker production host-setup guidance):
// warn once per violation — SMT on, KSM on, swap active — with the fix
// to apply. Non-fatal by design (kernel/boot configuration is outside the
// daemon's reach) and a no-op where the sysfs knobs don't exist (macOS
// dev, containers).
await checkHostHygiene({ logger });

// Resolve prebuilt guest artifacts (issue #819, phase 2) BEFORE
// initialize(): download the versioned, checksum-verified kernel + rootfs
// from the release assets unless they are already installed (or
// FIRECRACKER_ARTIFACTS_LOCAL is set). A protocol/checksum mismatch is
// fatal; a network failure with artifacts already present is a warning.
try {
  await ensureGuestArtifacts(
    {
      kernelPath: fcEnv.FIRECRACKER_KERNEL_PATH,
      rootfsPath: fcEnv.FIRECRACKER_ROOTFS_PATH,
      version: fcEnv.FIRECRACKER_ARTIFACTS_VERSION,
      local: fcEnv.FIRECRACKER_ARTIFACTS_LOCAL,
    },
    { logger },
  );
} catch (err) {
  fatal("guest artifacts", err);
}

// Warm the host page cache for the boot artifacts in the background
// (issue #835): after a host reboot the first run otherwise pays cold-disk
// virtio-blk latency for the whole guest boot read set. Deliberately not
// awaited — a slow disk must not delay daemon readiness, and the warm is
// pure best-effort (it logs, never throws).
void warmHostPageCache([fcEnv.FIRECRACKER_ROOTFS_PATH, fcEnv.FIRECRACKER_KERNEL_PATH], {
  logger,
});

// The guest-visible platform URL comes from the daemon's env, not from
// the platform process env — on this host there IS no platform process.
const orchestrator = new FirecrackerOrchestrator({
  platformApiUrl: runnerEnv.FIRECRACKER_RUNNER_PLATFORM_URL,
});

try {
  // Host preflight: Linux, /dev/kvm, artifacts, firewall bootstrap. A
  // daemon that cannot run VMs must not answer health checks.
  await orchestrator.initialize();
} catch (err) {
  fatal("orchestrator initialize", err);
}

// Crash recovery: reclaim TAPs/dirs/VMM processes left by a previous
// daemon that died mid-run, before accepting new work.
const report = await orchestrator.cleanupOrphans();
logger.info("appstrate-runner orphan sweep complete", { ...report });

// Self-verify the guest→platform path through the freshly-applied nft
// policy BEFORE the port opens — the DNAT drop that once cost 3h of
// tcpdump becomes a one-line boot diagnostic here. Own HostExec (the
// orchestrator's is private): both are stateless. FIRECRACKER_NET_VERIFY
// decides whether a PROVEN failure is fatal; a merely unverifiable path
// is always non-fatal.
let health: GuestPathResult = { platformReachable: false, guestPathVerified: null };
try {
  health = await verifyGuestPath({
    exec: createHostExec(),
    platformUrl: runnerEnv.FIRECRACKER_RUNNER_PLATFORM_URL,
    subnetCidr: fcEnv.FIRECRACKER_SUBNET_CIDR,
    mode: fcEnv.FIRECRACKER_NET_VERIFY,
  });
} catch (err) {
  // The probe is best-effort instrumentation — a bug inside it must never
  // sink a daemon that is otherwise ready to serve.
  logger.warn("appstrate-runner guest-path probe errored — treating as unverified", {
    error: getErrorMessage(err),
  });
}
if (fcEnv.FIRECRACKER_NET_VERIFY === "strict" && health.guestPathVerified === false) {
  fatal(
    "guest-path verification (FIRECRACKER_NET_VERIFY=strict)",
    new Error("guest→platform path is dropped by the host firewall — see the diagnostic above"),
  );
}

const app = createRunnerApp({
  orchestrator,
  token: runnerEnv.FIRECRACKER_RUNNER_TOKEN,
  health,
});

// Listen transport (issue #868): a Unix socket when
// FIRECRACKER_RUNNER_SOCKET is set (co-located platform container
// bind-mounts the socket dir — the wire never touches the network),
// TCP host:port otherwise.
const listen = resolveListenConfig(runnerEnv);
if (listen.kind === "unix") {
  // Host/port always have schema defaults, so only RAW process.env
  // reveals whether the operator set them explicitly — worth a heads-up
  // that the socket takes precedence, silence would look like a hang on
  // the port they expected.
  if (
    process.env.FIRECRACKER_RUNNER_HOST !== undefined ||
    process.env.FIRECRACKER_RUNNER_PORT !== undefined
  ) {
    logger.info(
      "FIRECRACKER_RUNNER_SOCKET is set — ignoring FIRECRACKER_RUNNER_HOST/FIRECRACKER_RUNNER_PORT",
      { socket: listen.socketPath },
    );
  }
  // The socket's directory may not exist on a fresh host (/run subdirs
  // are tmpfs, gone after reboot); a stale socket FILE from a crashed
  // daemon must be unlinked too — Bun.serve refuses to bind over one.
  await mkdir(dirname(listen.socketPath), { recursive: true });
  await unlink(listen.socketPath).catch(() => {});
}

// idleTimeout: 0 disables Bun's idle timeout entirely on BOTH branches:
// the exit route long-polls 45s and the log route streams NDJSON for the
// whole run — either would be severed by the 10s default. (@types/bun
// only declares idleTimeout on the TCP options branch, but the runtime
// honors it per-connection regardless of transport — hence the cast.)
const server =
  listen.kind === "unix"
    ? Bun.serve({
        unix: listen.socketPath,
        fetch: app.fetch,
        idleTimeout: 0,
      } as unknown as Parameters<typeof Bun.serve>[0])
    : Bun.serve({
        hostname: listen.host,
        port: listen.port,
        fetch: app.fetch,
        idleTimeout: 0,
      });

if (listen.kind === "unix") {
  // chmod AFTER bind (the node only exists then). Default 0660 —
  // root-owned; the platform container typically runs uid 0, so
  // root:root 0660 works on plain Docker. Bearer-token auth in
  // server.ts stays enforced regardless — this is defense-in-depth.
  await chmod(listen.socketPath, listen.mode);
  logger.info("appstrate-runner listening (unix socket)", {
    socket: listen.socketPath,
    platformUrl: runnerEnv.FIRECRACKER_RUNNER_PLATFORM_URL,
  });
} else {
  logger.info("appstrate-runner listening", {
    host: listen.host,
    port: listen.port,
    platformUrl: runnerEnv.FIRECRACKER_RUNNER_PLATFORM_URL,
  });
}

async function shutdown(signal: string): Promise<void> {
  logger.info("appstrate-runner shutting down", { signal });
  // Stop accepting new requests first, then tear down VMs — the reverse
  // order would let the platform start a run into a dying daemon.
  server.stop();
  // Best-effort socket cleanup — a leftover node would force the NEXT
  // boot through the stale-socket unlink path anyway, but tidying here
  // keeps `ls` honest. Never throws (shutdown must reach exit(0)).
  if (listen.kind === "unix") {
    await unlink(listen.socketPath).catch(() => {});
  }
  try {
    await orchestrator.shutdown();
  } catch (err) {
    logger.error("appstrate-runner shutdown error", { error: getErrorMessage(err) });
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
