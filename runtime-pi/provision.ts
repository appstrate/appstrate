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
export const PROVISION_MAX_ATTEMPTS = 9;

export interface ProvisionDeps {
  /** The run-scoped event sink URL (`…/api/runs/:id/events`). The workspace
   *  and documents routes are derived by swapping the `/events` suffix. */
  sinkUrl: string;
  /** Run secret used to HMAC-sign each GET (Standard Webhooks). */
  sinkSecret: string;
  /** Absolute workspace root the bundle + documents are written under. */
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
 * 5xx, 429, and network errors with exponential backoff; throws only when the
 * budget is exhausted on transient failures.
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
      const res = await fetchFn(url, { method: "GET", headers });
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
  // bundled runtime (see `provisionDocuments`).
  await fs.mkdir(deps.workspace, { recursive: true });
  const bytes = new Uint8Array(await res.arrayBuffer());
  await Bun.write(path.join(deps.workspace, "agent-package.afps"), bytes);
}

/**
 * Self-provision the run's input documents, streaming each to
 * `workspace/documents/<name>`.
 *
 * Documents are delivered out-of-band from the bundle: large and variable,
 * they are fetched individually and streamed straight to disk, so the agent
 * never buffers the whole payload — peak memory stays bounded regardless of
 * upload size. The manifest enumerates them; a 404 on the manifest means the
 * run carries no documents (the common case) and is NOT a fault. A non-ok on a
 * document the manifest listed IS fatal, same reasoning as the bundle (#549).
 */
export async function provisionDocuments(deps: ProvisionDeps): Promise<void> {
  const manifestUrl = deps.sinkUrl.replace(/\/events$/, "/documents");
  let manifestRes: Response;
  try {
    manifestRes = await signedGetWithRetry(manifestUrl, deps);
  } catch (err) {
    return await deps.die(`Failed to fetch documents manifest: ${getErrorMessage(err)}`);
  }
  if (manifestRes.status === 404) return; // run carries no input documents
  if (!manifestRes.ok) {
    return await deps.die(`Failed to fetch documents manifest: HTTP ${manifestRes.status}`);
  }

  // The manifest carries a `name` (human display name) and a `workspace_name`
  // (the unique single-segment filename to write on disk); the platform
  // guarantees `workspace_name` is unique per run so two documents never
  // overwrite each other here (see the platform's run-document-naming.ts).
  // A pre-upgrade platform serves manifests without `workspace_name` — fall
  // back to `name` (the old on-disk key) rather than silently provisioning
  // zero documents.
  const manifest = (await manifestRes.json()) as {
    documents?: { workspace_name?: unknown; name?: unknown }[];
  };
  const names = (manifest.documents ?? [])
    .map((d) => d.workspace_name ?? d.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  if (names.length === 0) return;

  const dir = path.join(deps.workspace, "documents");
  await fs.mkdir(dir, { recursive: true });

  // Sequential: input-document sets are small (typically 1–few files), so
  // streaming each in turn bounds open connections and peak memory without a
  // concurrency primitive.
  for (const name of names) {
    // Defence-in-depth: the platform sanitises names to a single path segment,
    // but never write outside `dir` on a malformed manifest.
    if (path.basename(name) !== name || name === "." || name === "..") {
      return await deps.die(`Refusing unsafe document name: ${name}`);
    }
    let docRes: Response;
    try {
      docRes = await signedGetWithRetry(`${manifestUrl}/${encodeURIComponent(name)}`, deps);
    } catch (err) {
      return await deps.die(`Failed to fetch document ${name}: ${getErrorMessage(err)}`);
    }
    if (!docRes.ok || !docRes.body) {
      return await deps.die(`Failed to fetch document ${name}: HTTP ${docRes.status}`);
    }
    // Stream the response body to disk chunk-by-chunk — peak memory stays
    // bounded regardless of document size (WORKSPACE_MAX_DOCS_BYTES allows up
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
        // in the sink buffer — keeps peak memory flat for large documents.
        await writer.flush();
      }
    } catch (err) {
      // A mid-stream read/write failure is fatal, same as a non-ok fetch: route
      // it through `die()` so the run gets an `appstrate.error` breadcrumb
      // rather than crashing out as an unhandled rejection.
      return await deps.die(`Failed to stream document ${name}: ${getErrorMessage(err)}`);
    } finally {
      reader.releaseLock();
      await writer.end();
    }
  }
}
