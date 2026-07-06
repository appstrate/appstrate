// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP surface of the `appstrate-runner` daemon (issue #819, phase 1) —
 * a thin, dumb wire adapter over a {@link RunOrchestrator}. Every route
 * is body-validate → orchestrator call → JSON mirror of the return
 * value; all sequencing intelligence (boundary before workload, sidecar
 * before agent start) stays platform-side in the remote client, so the
 * daemon never grows run-lifecycle opinions of its own.
 *
 * Split from daemon.ts so tests can drive the full app via
 * `app.request()` with a fake orchestrator — no port, no KVM, no Linux.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { stream } from "hono/streaming";
import type { z } from "zod";
import type {
  IsolationBoundary,
  RunOrchestrator,
  SidecarLaunchSpec,
  WorkloadHandle,
  WorkloadSpec,
} from "@appstrate/core/platform-types";
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "./logger.ts";
import {
  BoundaryExistsError,
  CONSOLE_DEFAULT_TAIL_BYTES,
  CONSOLE_ID_RE,
  CONSOLE_ROUTE_PATTERN,
  EXIT_LONG_POLL_MS,
  RUNNER_PROTOCOL_VERSION,
  RUNNER_ROUTES,
  consoleQuerySchema,
  createBoundaryBodySchema,
  createSidecarBodySchema,
  createWorkloadBodySchema,
  handleBodySchema,
  logsBodySchema,
  removeBoundaryBodySchema,
  stopRunBodySchema,
  stopWorkloadBodySchema,
} from "./protocol.ts";

/**
 * Request body cap. The largest legitimate body is a sidecar/workload
 * launch spec (env + credential bundle) — kilobytes in practice. Without
 * an explicit cap Bun.serve would accept up to its 128 MiB default, so a
 * single hostile POST could pin daemon memory. 4 MiB leaves generous
 * headroom over any real spec.
 */
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

/** Liveness snapshot returned by {@link RunnerOrchestrator.workloadStatus}. */
export interface WorkloadStatus {
  running: boolean;
}

/**
 * Observability capabilities the daemon's engine adds on top of the
 * transport-neutral {@link RunOrchestrator} contract (phase 4). Kept OFF
 * the shared interface so the docker/process orchestrators — which do not
 * back this daemon — are not forced to implement them; the daemon always
 * drives a {@link FirecrackerOrchestrator}, which does.
 */
export interface RunnerOrchestrator extends RunOrchestrator {
  /** Whether the daemon still holds a live VMM process for the workload. */
  workloadStatus(handle: WorkloadHandle): WorkloadStatus | Promise<WorkloadStatus>;
  /**
   * Console tail for a run, served from the live workspace while the VM
   * runs, else from the post-teardown archive. `null` when neither exists.
   */
  readConsole(id: string, tailBytes: number): Promise<string | null>;
}

export interface RunnerAppDeps {
  orchestrator: RunnerOrchestrator;
  /** Shared bearer secret — every request must present it. */
  token: string;
  /**
   * Long-poll window for the exit route. Injectable so unit tests can
   * observe the `{ done: false }` timeout branch in milliseconds instead
   * of waiting the production 45s.
   */
  exitLongPollMs?: number;
  /**
   * Guest→platform self-verification snapshot, computed once at boot
   * (see runner/net-probe.ts) and reported verbatim on /v1/health so the
   * platform's initialize() handshake surfaces it to the operator. Absent
   * = probe not run (the field is simply omitted from the payload).
   */
  health?: {
    platformReachable: boolean;
    guestPathVerified: boolean | null;
  };
}

/**
 * SHA-256 both sides before comparing: the digests always have the same
 * length, so neither the comparison loop nor a length check can leak how
 * many prefix characters of the real token an attacker got right.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = new Bun.CryptoHasher("sha256").update(presented).digest();
  const b = new Bun.CryptoHasher("sha256").update(expected).digest();
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Parse + validate a JSON body. Returns the typed data or a ready 400
 * response (malformed JSON and schema violations are both client errors
 * — the orchestrator must never see an unvalidated payload).
 */
async function readBody<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, res: c.json({ error: "invalid JSON body" }, 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    return { ok: false, res: c.json({ error: summary }, 400) };
  }
  return { ok: true, data: parsed.data };
}

/** Build the daemon's Hono app. Pure — no env reads, no side effects. */
export function createRunnerApp(deps: RunnerAppDeps): Hono {
  const { orchestrator, token } = deps;
  const exitLongPollMs = deps.exitLongPollMs ?? EXIT_LONG_POLL_MS;
  const app = new Hono();

  // Orchestrator failures surface as 500 {error} — message only, never a
  // stack trace: the platform logs the message per-run, the daemon log
  // keeps the full error for the host operator.
  app.onError((err, c) => {
    logger.error("Runner route failed", { path: c.req.path, error: getErrorMessage(err) });
    return c.json({ error: getErrorMessage(err) }, 500);
  });

  app.use("*", async (c, next) => {
    const header = c.req.header("authorization");
    const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!presented || !tokenMatches(presented, token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  // Cap the request body AFTER auth — an unauthenticated flood is rejected
  // by the 401 above without buffering. 413 mirrors the daemon's {error}
  // JSON convention instead of Hono's default plaintext body.
  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_REQUEST_BODY_BYTES,
      onError: (c) => c.json({ error: "request body too large" }, 413),
    }),
  );

  app.get(RUNNER_ROUTES.health, async (c) =>
    c.json({
      ok: true,
      adapter: "firecracker",
      protocol: RUNNER_PROTOCOL_VERSION,
      // The daemon binds its port only AFTER orchestrator.initialize()
      // succeeded (see daemon.ts) — a reachable daemon is an initialized
      // one by construction.
      initialized: true,
      // The guest-visible platform URL is a daemon-side topology fact; the
      // client caches it from this handshake (no separate round-trip).
      platformUrl: await orchestrator.resolvePlatformApiUrl(),
      // Boot-time net-probe result. Defaulted when the daemon skipped the
      // probe so both fields are always present on the wire.
      platformReachable: deps.health?.platformReachable ?? false,
      guestPathVerified: deps.health?.guestPathVerified ?? null,
    }),
  );

  app.post(RUNNER_ROUTES.createBoundary, async (c) => {
    const body = await readBody(c, createBoundaryBodySchema);
    if (!body.ok) return body.res;
    try {
      const boundary = await orchestrator.createIsolationBoundary(body.data.runId, body.data.opts);
      return c.json(boundary);
    } catch (err) {
      // Replay/duplicate guard: on a plaintext-bearer transport a captured
      // request can be re-POSTed verbatim — a duplicate create must never
      // allocate a second boundary (TAP + subnet slot) for the same run.
      // 409 (not 200 with the existing boundary) keeps ownership single:
      // handing the boundary back would let a second caller believe it
      // owns the run and tear it down under the first one's feet.
      if (err instanceof BoundaryExistsError) {
        logger.warn("Duplicate boundary creation rejected", { runId: body.data.runId });
        return c.json({ error: getErrorMessage(err) }, 409);
      }
      throw err;
    }
  });

  app.post(RUNNER_ROUTES.removeBoundary, async (c) => {
    const body = await readBody(c, removeBoundaryBodySchema);
    if (!body.ok) return body.res;
    await orchestrator.removeIsolationBoundary(body.data.boundary as IsolationBoundary);
    return c.body(null, 204);
  });

  app.post(RUNNER_ROUTES.createSidecar, async (c) => {
    const body = await readBody(c, createSidecarBodySchema);
    if (!body.ok) return body.res;
    // The spec schema is deliberately loose (see protocol.ts) — forward
    // it verbatim so additive SidecarLaunchSpec fields survive the wire
    // without a daemon redeploy.
    const handle = await orchestrator.createSidecar(
      body.data.runId,
      body.data.boundary as IsolationBoundary,
      body.data.spec as SidecarLaunchSpec,
    );
    return c.json(handle);
  });

  app.post(RUNNER_ROUTES.createWorkload, async (c) => {
    const body = await readBody(c, createWorkloadBodySchema);
    if (!body.ok) return body.res;
    const handle = await orchestrator.createWorkload(
      body.data.spec as WorkloadSpec,
      body.data.boundary as IsolationBoundary,
    );
    return c.json(handle);
  });

  app.post(RUNNER_ROUTES.startWorkload, async (c) => {
    const body = await readBody(c, handleBodySchema);
    if (!body.ok) return body.res;
    await orchestrator.startWorkload(body.data.handle);
    return c.body(null, 204);
  });

  app.post(RUNNER_ROUTES.stopWorkload, async (c) => {
    const body = await readBody(c, stopWorkloadBodySchema);
    if (!body.ok) return body.res;
    await orchestrator.stopWorkload(body.data.handle, body.data.timeoutSeconds);
    return c.body(null, 204);
  });

  app.post(RUNNER_ROUTES.removeWorkload, async (c) => {
    const body = await readBody(c, handleBodySchema);
    if (!body.ok) return body.res;
    await orchestrator.removeWorkload(body.data.handle);
    return c.body(null, 204);
  });

  app.post(RUNNER_ROUTES.waitForExit, async (c) => {
    const body = await readBody(c, handleBodySchema);
    if (!body.ok) return body.res;
    // Long-poll: answer { done: false } after the window instead of
    // holding the connection for the whole run — proxies and NATs kill
    // idle connections, so the client re-polls in bounded slices.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        orchestrator.waitForExit(body.data.handle).then((code) => ({ done: true as const, code })),
        new Promise<{ done: false }>((resolve) => {
          timer = setTimeout(() => resolve({ done: false }), exitLongPollMs);
        }),
      ]);
      return c.json(result);
    } finally {
      // Always reclaim the timer — a resolved exit must not leave a
      // dangling handle (keeps bun test from hanging on open timers).
      clearTimeout(timer);
    }
  });

  app.post(RUNNER_ROUTES.streamLogs, async (c) => {
    const body = await readBody(c, logsBodySchema);
    if (!body.ok) return body.res;
    const { handle, skip } = body.data;
    c.header("Content-Type", "application/x-ndjson");
    return stream(
      c,
      async (s) => {
        let skipped = 0;
        // The request's abort signal is threaded into the generator so a
        // disconnected client stops the underlying file tail instead of
        // leaking it for the rest of the run.
        for await (const line of orchestrator.streamLogs(handle, c.req.raw.signal)) {
          if (skipped < skip) {
            skipped++;
            continue;
          }
          await s.write(JSON.stringify({ line }) + "\n");
        }
      },
      async (err) => {
        // Headers are already sent — nothing to answer, just log and let
        // the truncated stream signal the client to reconnect (with skip).
        logger.error("Runner log stream failed", {
          runId: handle.runId,
          error: getErrorMessage(err),
        });
      },
    );
  });

  app.post(RUNNER_ROUTES.stopRun, async (c) => {
    const body = await readBody(c, stopRunBodySchema);
    if (!body.ok) return body.res;
    const result = await orchestrator.stopByRunId(body.data.runId, body.data.timeoutSeconds);
    return c.json({ result });
  });

  // Boot-phase liveness probe (phase 4): the platform's heartbeat pump
  // reads this to decide whether to keep synthesising heartbeats for a
  // still-booting guest — it never masks a dead VM because `running`
  // reflects the actual VMM process.
  app.post(RUNNER_ROUTES.workloadStatus, async (c) => {
    const body = await readBody(c, handleBodySchema);
    if (!body.ok) return body.res;
    const status = await orchestrator.workloadStatus(body.data.handle);
    return c.json(status);
  });

  // Console retention (phase 4): serves the run's serial console from the
  // live workspace while the VM runs, else from the post-teardown archive.
  // The platform fetches a small tail here to attach to an abnormally
  // exited run — the console that used to vanish with the workspace.
  app.get(CONSOLE_ROUTE_PATTERN, async (c) => {
    const id = c.req.param("id");
    if (!CONSOLE_ID_RE.test(id)) {
      return c.json({ error: "invalid workload id" }, 400);
    }
    const query = consoleQuerySchema.safeParse({ tailBytes: c.req.query("tailBytes") });
    // `.catch(...)` inside the schema makes a parse failure impossible, but
    // guard defensively rather than assert.
    const tailBytes = query.success ? query.data.tailBytes : CONSOLE_DEFAULT_TAIL_BYTES;
    const text = await orchestrator.readConsole(id, tailBytes);
    if (text === null) {
      return c.json({ error: `no console for workload ${id}` }, 404);
    }
    return c.body(text, 200, { "content-type": "text/plain; charset=utf-8" });
  });

  return app;
}
