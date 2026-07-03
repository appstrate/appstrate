// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate-runner` daemon entrypoint (issue #819, phase 1).
 *
 * Runs directly on the KVM host and exposes the local
 * {@link FirecrackerOrchestrator} over the wire protocol in
 * ./protocol.ts, so a CONTAINERIZED platform (which cannot touch
 * /dev/kvm, TAP devices, or nftables) can still drive microVM runs:
 *
 *   platform container ── firecracker-remote client ──HTTP──▶ this daemon ──▶ microVMs
 *
 * Start on the host:
 *
 *   FIRECRACKER_RUNNER_TOKEN=… \
 *   FIRECRACKER_RUNNER_PLATFORM_URL=http://<host-ip>:3000 \
 *   bun run firecracker:runner
 *
 * Boot order is deliberate: env → initialize() → orphan sweep → listen.
 * The port only opens after the host firewall and artifacts are proven
 * good, which is what lets /v1/health hardcode `initialized: true`.
 */

import { FirecrackerOrchestrator } from "../orchestrator.ts";
import { getFirecrackerEnv } from "../env.ts";
import { getRunnerEnv } from "./env.ts";
import { createRunnerApp } from "./server.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "../../../lib/logger.ts";

function fatal(step: string, err: unknown): never {
  logger.error(`appstrate-runner failed to start: ${step}`, { error: getErrorMessage(err) });
  process.exit(1);
}

// Fail fast on malformed configuration BEFORE touching the host: a bad
// CIDR or missing token must be a one-line startup error, not a
// mid-run surprise. Both surfaces are validated — the daemon's own
// (FIRECRACKER_RUNNER_*) and the orchestrator's (FIRECRACKER_*).
let runnerEnv: ReturnType<typeof getRunnerEnv>;
try {
  runnerEnv = getRunnerEnv();
  getFirecrackerEnv();
} catch (err) {
  fatal("invalid environment", err);
}

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

const app = createRunnerApp({ orchestrator, token: runnerEnv.FIRECRACKER_RUNNER_TOKEN });

const server = Bun.serve({
  hostname: runnerEnv.FIRECRACKER_RUNNER_HOST,
  port: runnerEnv.FIRECRACKER_RUNNER_PORT,
  fetch: app.fetch,
  // 0 disables Bun's idle timeout entirely: the exit route long-polls
  // 45s and the log route streams NDJSON for the whole run — either
  // would be severed by the 10s default.
  idleTimeout: 0,
});

logger.info("appstrate-runner listening", {
  host: runnerEnv.FIRECRACKER_RUNNER_HOST,
  port: runnerEnv.FIRECRACKER_RUNNER_PORT,
  platformUrl: runnerEnv.FIRECRACKER_RUNNER_PLATFORM_URL,
});

async function shutdown(signal: string): Promise<void> {
  logger.info("appstrate-runner shutting down", { signal });
  // Stop accepting new requests first, then tear down VMs — the reverse
  // order would let the platform start a run into a dying daemon.
  server.stop();
  try {
    await orchestrator.shutdown();
  } catch (err) {
    logger.error("appstrate-runner shutdown error", { error: getErrorMessage(err) });
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
