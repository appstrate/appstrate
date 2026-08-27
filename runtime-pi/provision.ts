// SPDX-License-Identifier: Apache-2.0

/**
 * Agent-container workspace self-provisioning.
 *
 * Extracted from `entrypoint.ts` so the boot-critical fetch + stream-to-disk
 * paths are unit-testable in isolation (the entrypoint itself is a top-level
 * `await` script with module side effects + `process.exit`, so it can't be
 * imported). Every external dependency — the sink URL/secret, the workspace
 * path, the fatal-error escalation, and `fetch`/`sleep` — is injected via
 * {@link ProvisionDeps}, so a test drives these against a local HTTP server
 * with no globals or real backoff delays.
 *
 * Behaviour is identical to the inlined versions; see the per-function docs.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { sign } from "@appstrate/afps-runtime/events";
import { computeBackoffDelayMs, isRetryableHttpStatus } from "@appstrate/afps-shared/backoff";
import { getErrorMessage } from "@appstrate/core/errors";

/**
 * Generous retry budget: workspace provisioning is the first blocking network
 * call, and with a sidecar the forward proxy may still be binding. The proxy
 * typically comes up a few hundred ms after the agent's first attempt, so the
 * early retries poll tightly (120 ms base — a 500 ms base overshot the proxy
 * by up to a full doubled sleep on every boot); 9 attempts span ~9.7 s
 * (0.12+0.24+0.48+0.96+1.92+2+2+2 s), a slightly larger total budget than the
 * previous 6×500ms (7.5 s), still well inside the boot gate.
 */
const PROVISION_MAX_ATTEMPTS = 9;

/**
 * Per-attempt deadline on the platform's RESPONSE HEADERS.
 *
 * Without it the budget above is unreachable: a platform that accepts the
 * connection and never answers leaves attempt 1 pending forever, so the 9
 * attempts never happen and boot hangs. Nothing else catches that — the run
 * watchdog's agent budget starts at the run loop, boot excluded
 * (`entrypoint.ts`).
 *
 * 10 s, sized against the two ends it sits between. Below: this is a
 * platform-local hop (through the sidecar forward proxy when attached), whose
 * honest time-to-first-byte at boot is sub-second — 10 s is more than an order
 * of magnitude of headroom, so it cannot fire on a merely slow platform.
 * Above: the whole loop must finish well inside `RUN_BOOT_DEADLINE_SECONDS`
 * (300 s) or the failure surfaces as an opaque boot-deadline reap instead of
 * the "failed after N attempts" message this function raises; 9 × 10 s plus
 * ~9.7 s of backoff is ~100 s, a 3× margin. A 30 s bound would fit only
 * barely, and buys nothing this hop needs.
 *
 * HEADERS only, then disarmed: a signal handed to `fetch` aborts the BODY too,
 * and `provisionFiles` streams input files (up to `WORKSPACE_MAX_FILES_BYTES`,
 * 256 MiB) off the very `Response` this function returns. A whole-request cap
 * would kill a healthy large download mid-stream.
 */
const PROVISION_HEADERS_TIMEOUT_MS = 10_000;

export interface ProvisionDeps {
  /** The run-scoped event sink URL (`…/api/runs/:id/events`). The workspace
   *  and files routes are derived by swapping the `/events` suffix. */
  sinkUrl: string;
  /** Run secret used to HMAC-sign each GET (Standard Webhooks). */
  sinkSecret: string;
  /** Absolute workspace root the bundle + files are written under. */
  workspace: string;
  /**
   * Fatal-error escalation. In production this posts an `appstrate.error`
   * event and `process.exit(1)`s (never returns); in tests it throws so the
   * calling provision step halts and the assertion can inspect the message.
   */
  die: (message: string) => Promise<never>;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  /** Injected for tests; defaults to {@link PROVISION_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Backoff sleeper; injected so tests skip the real exponential delay. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Signed GET against a run-scoped platform route, with the provisioning retry
 * budget. Re-signs each attempt (fresh timestamp). Returns the {@link Response}
 * as soon as it is `ok` OR carries a deterministic non-retryable status (4xx
 * other than 429 — the caller decides whether that status is fatal). Retries
 * 5xx, 429, network errors, and attempts whose response headers do not arrive
 * within {@link PROVISION_HEADERS_TIMEOUT_MS}, with exponential backoff; throws
 * only when the budget is exhausted on transient failures.
 *
 * Auth mirrors the event sink: a Standard Webhooks HMAC over the (empty) GET
 * body keyed on the run secret. Outbound traffic reaches the platform exactly
 * as the sink does — through the sidecar forward proxy when attached, directly
 * over the egress network when not — so no extra wiring is needed.
 */
export async function signedGetWithRetry(url: string, deps: ProvisionDeps): Promise<Response> {
  const fetchFn = deps.fetchFn ?? fetch;
  const maxAttempts = deps.maxAttempts ?? PROVISION_MAX_ATTEMPTS;
  const sleep = deps.sleep ?? defaultSleep;
  let lastError = "unknown error";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const headers: Record<string, string> = {
        ...sign({
          msgId: randomUUID(),
          timestampSec: Math.floor(Date.now() / 1000),
          body: "",
          secret: deps.sinkSecret,
        }),
      };
      // Arm the headers deadline for this attempt and disarm it the moment the
      // response object exists (or the attempt fails) — see
      // `PROVISION_HEADERS_TIMEOUT_MS` for why it must not outlive the headers.
      // A fired deadline rejects with a `TimeoutError`, which the `catch` below
      // already classifies as a retryable failure, so a hung attempt now spends
      // one attempt of the budget instead of all of it.
      const deadline = new AbortController();
      const timer = setTimeout(
        () =>
          deadline.abort(
            new DOMException(
              `no response headers after ${PROVISION_HEADERS_TIMEOUT_MS}ms`,
              "TimeoutError",
            ),
          ),
        PROVISION_HEADERS_TIMEOUT_MS,
      );
      let res: Response;
      try {
        res = await fetchFn(url, { method: "GET", headers, signal: deadline.signal });
      } finally {
        clearTimeout(timer);
      }
      // Success, or a deterministic 4xx (404 missing, 401 bad signature, 410
      // closed/expired sink) that retrying cannot fix — hand back either way.
      if (res.ok || !isRetryableHttpStatus(res.status)) return res;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = getErrorMessage(err);
    }
    if (attempt < maxAttempts) {
      await sleep(computeBackoffDelayMs(attempt, { baseMs: 120, capMs: 2000 }));
    }
  }
  throw new Error(`request to ${url} failed after ${maxAttempts} attempts: ${lastError}`);
}

/**
 * Self-provision the AFPS bundle by fetching it from the platform and writing
 * it into the workspace as `agent-package.afps`.
 *
 * Any non-2xx is fatal — including `404`. The platform always uploads at least
 * the agent package (`buildAgentPackage` never returns an empty bundle), so a
 * missing object is never a legitimate "empty workspace": it means the upload
 * was lost, deleted early, or the request was misrouted. Continuing in that
 * state is exactly the silent-degradation regression #549 fixed, so we fail
 * loud instead.
 */
export async function provisionWorkspace(deps: ProvisionDeps): Promise<void> {
  const url = deps.sinkUrl.replace(/\/events$/, "/workspace");
  let res: Response;
  try {
    res = await signedGetWithRetry(url, deps);
  } catch (err) {
    return await deps.die(`Failed to provision workspace from platform: ${getErrorMessage(err)}`);
  }
  if (!res.ok) {
    return await deps.die(`Failed to provision workspace from platform: HTTP ${res.status}`);
  }
  // The bundle is the `agent-package.afps` bytes (itself a ZIP the Pi runtime
  // reads). Buffer-then-write: the bundle is small + bounded, and passing the
  // fetch `Response` to `Bun.write` for streaming-consume busy-loops in the
  // bundled runtime (see `provisionFiles`).
  await fs.mkdir(deps.workspace, { recursive: true });
  const bytes = new Uint8Array(await res.arrayBuffer());
  await Bun.write(path.join(deps.workspace, "agent-package.afps"), bytes);
}

/**
 * Self-provision the run's input files, streaming each to
 * `workspace/files/<name>`.
 *
 * Files are delivered out-of-band from the bundle: large and variable,
 * they are fetched individually and streamed straight to disk, so the agent
 * never buffers the whole payload — peak memory stays bounded regardless of
 * upload size. The manifest enumerates them; a 404 on the manifest means the
 * run carries no files (the common case) and is NOT a fault. A non-ok on a
 * file the manifest listed IS fatal, same reasoning as the bundle (#549).
 */
export async function provisionFiles(deps: ProvisionDeps): Promise<void> {
  // `/files` is the ONLY manifest path. There is no `/documents` probe: the
  // platform that serves this container validates at boot that `PI_IMAGE` and
  // `SIDECAR_IMAGE` carry its own version (`@appstrate/env`, via
  // `findRuntimeImageTagMismatch`), so the counterpart on the other end of this
  // request is never a platform older than this image — and no released
  // platform ever served `/documents` anyway (the rename landed after
  // `v1.0.0-beta.51`). A 404 here therefore carries exactly ONE meaning, the
  // one the route documents: this run carries no input files.
  const manifestUrl = deps.sinkUrl.replace(/\/events$/, "/files");
  let manifestRes: Response;
  try {
    manifestRes = await signedGetWithRetry(manifestUrl, deps);
  } catch (err) {
    return await deps.die(`Failed to fetch files manifest: ${getErrorMessage(err)}`);
  }
  if (manifestRes.status === 404) return; // run carries no input files
  if (!manifestRes.ok) {
    return await deps.die(`Failed to fetch files manifest: HTTP ${manifestRes.status}`);
  }

  // The manifest carries a `name` (human display name) and a `workspace_name`
  // (the unique single-segment filename to write on disk); the platform
  // guarantees `workspace_name` is present and unique per run — its manifest
  // reader rejects any entry without one — so two files never overwrite
  // each other here (see the platform's run-file-naming.ts). The runtime
  // still type-checks the field rather than trusting the JSON blindly.
  const manifest = (await manifestRes.json()) as {
    files?: { workspace_name?: unknown }[];
  };
  const names = (manifest.files ?? [])
    .map((d) => d.workspace_name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  if (names.length === 0) return;

  // `files/` is the ONE directory the run's input files land in, and the one
  // the platform prompt announces (`prompt-builder.ts` — `./files/<name>`,
  // unconditionally). The two must stay spelled the same: a divergence is a
  // prompt-level miss with the bytes sitting in a directory the agent is never
  // told about, and nothing reports a fault.
  const dir = path.join(deps.workspace, "files");
  await fs.mkdir(dir, { recursive: true });

  // Sequential: input-file sets are small (typically 1–few files), so
  // streaming each in turn bounds open connections and peak memory without a
  // concurrency primitive.
  for (const name of names) {
    // Defence-in-depth: the platform sanitises names to a single path segment,
    // but never write outside `dir` on a malformed manifest.
    if (path.basename(name) !== name || name === "." || name === "..") {
      return await deps.die(`Refusing unsafe file name: ${name}`);
    }
    let docRes: Response;
    try {
      docRes = await signedGetWithRetry(`${manifestUrl}/${encodeURIComponent(name)}`, deps);
    } catch (err) {
      return await deps.die(`Failed to fetch file ${name}: ${getErrorMessage(err)}`);
    }
    if (!docRes.ok || !docRes.body) {
      return await deps.die(`Failed to fetch file ${name}: HTTP ${docRes.status}`);
    }
    // Stream the response body to disk chunk-by-chunk — peak memory stays
    // bounded regardless of file size (WORKSPACE_MAX_FILES_BYTES allows up
    // to 256 MiB). We DO NOT use `Bun.write(path, docRes)` / `Bun.write(path,
    // docRes.body)`: handing the fetch `Response`/stream to `Bun.write` for
    // streaming-consume busy-loops at 100% CPU in the bundled runtime,
    // starving the event loop so the sink heartbeat never fires and the run is
    // killed at the 60s watchdog. Draining the reader explicitly into a
    // FileSink avoids that code path while preserving O(1) memory.
    const writer = Bun.file(path.join(dir, name)).writer();
    const reader = docRes.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        writer.write(value);
        // Apply backpressure so a fast upstream cannot queue unbounded chunks
        // in the sink buffer — keeps peak memory flat for large files.
        await writer.flush();
      }
    } catch (err) {
      // A mid-stream read/write failure is fatal, same as a non-ok fetch: route
      // it through `die()` so the run gets an `appstrate.error` breadcrumb
      // rather than crashing out as an unhandled rejection.
      return await deps.die(`Failed to stream file ${name}: ${getErrorMessage(err)}`);
    } finally {
      reader.releaseLock();
      await writer.end();
    }
  }
}
