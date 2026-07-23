// SPDX-License-Identifier: Apache-2.0

/**
 * runtime-pi entrypoint — thin bootloader that wires the agent container
 * runtime into the shared {@link PiRunner}. The same `PiRunner` used
 * here is what external consumers instantiate against their own
 * {@link EventSink}; structural parity between in-container and out-of-
 * container execution is guaranteed by using the same class.
 *
 * Responsibilities (runtime-pi only):
 *   1. Initialise a git repo + extract the injected agent package.
 *   2. Install skills into `.pi/` for on-disk lookup (tool docs live on
 *      the MCP tool descriptors, not on disk).
 *   3. Collect tool extension factories (from agent package + built-ins).
 *   4. Build an {@link ExecutionContext} from env vars.
 *   5. Build an {@link HttpSink} against the platform's signed-event API.
 *   6. Instantiate {@link PiRunner} and `await runner.run(...)`.
 *
 * Wire protocol (agent ↔ platform): HMAC-signed CloudEvents over HTTP via
 * `@appstrate/afps-runtime/sinks.HttpSink`. Every runner — platform
 * container, CLI, GitHub Action — speaks the exact same protocol against
 * `/api/runs/:runId/events` and `/events/finalize`. No stdout parsing.
 *
 * Required env vars:
 *   - `APPSTRATE_SINK_URL`, `APPSTRATE_SINK_FINALIZE_URL`, `APPSTRATE_SINK_SECRET`
 *   - `AGENT_RUN_ID`, `AGENT_PROMPT`, `MODEL_API`, `MODEL_ID`
 *
 * Fatal failures (missing env, malformed bundle) post a single
 * `appstrate.error` event via HttpSink *and* a terminal failed
 * `RunResult` via finalize, then `process.exit(1)`. The platform's
 * container-monitor also synthesises a failed finalize on non-zero
 * exit — the CAS in `finalizeRemoteRun` guarantees idempotency.
 */

import * as fs from "node:fs/promises";
import { writeSync } from "node:fs";
import * as path from "node:path";
import type { ExtensionFactory, Api, Model } from "./pi-sdk.ts";
import {
  PiRunner,
  prepareBundleForPi,
  buildRuntimeToolExtensions,
  buildPublishDocumentExtension,
  deriveProviderFromApi,
  emitRuntimeReady,
  emitBootProgress,
  startSinkHeartbeat,
  loadPiCodingAgentSdk,
  type AppstrateToolCtx,
  type AppstrateCtxProvider,
} from "@appstrate/runner-pi";
import { getErrorMessage } from "@appstrate/core/errors";
import type { IntegrationBootReport } from "@appstrate/core/sidecar-types";
import {
  BUNDLE_FORMAT_VERSION,
  bundleIntegrity,
  computeRecordEntries,
  readBundleFromFile,
  recordIntegrity,
  serializeRecord,
  parsePackageIdentity,
  type Bundle,
  type PackageIdentity,
} from "@appstrate/afps-runtime/bundle";
import { HttpSink, attachStdoutBridge } from "@appstrate/afps-runtime/sinks";
import type { ExecutionContext, RunEvent } from "@appstrate/afps-runtime/types";
import { emptyRunResult } from "@appstrate/afps-runtime/runner";
import { createMcpHttpClient, type AppstrateMcpClient } from "@appstrate/mcp-transport";
import { wrapExtensionFactory } from "./extension-wrapper.ts";
import { parseRuntimeEnv, RuntimeEnvError } from "./env.ts";
import { buildMcpDirectFactories } from "./mcp/direct.ts";
import {
  createRuntimeEventDrainer,
  drainAndEmitInto,
  type RuntimeEventDrainer,
} from "@appstrate/core/runtime-event-drain";
import { provisionWorkspace, provisionDocuments, type ProvisionDeps } from "./provision.ts";
import { createRunDocumentUploader, sweepOutputs } from "./publish.ts";

/**
 * Synthesise a Bundle the runner can consume when no `.afps` ships
 * with the run. The platform pre-installs files into the workspace
 * directly in that case, so the bundle's content is never re-read —
 * but PiRunner.run() still wants a Bundle to satisfy the AFPS
 * Runner contract.
 */
function buildInContainerBundle(prompt: string): Bundle {
  const encoder = new TextEncoder();
  const manifestBytes = encoder.encode(
    JSON.stringify({ name: "@appstrate/in-container", version: "0.0.0", type: "agent" }),
  );
  const promptBytes = encoder.encode(prompt);
  const files = new Map<string, Uint8Array>([
    ["manifest.json", manifestBytes],
    ["prompt.md", promptBytes],
  ]);
  const recordBody = serializeRecord(computeRecordEntries(files));
  const integrity = recordIntegrity(recordBody);
  const identity = "@appstrate/in-container@0.0.0" as PackageIdentity;
  return {
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    root: identity,
    packages: new Map([
      [
        identity,
        {
          identity,
          manifest: { name: "@appstrate/in-container", version: "0.0.0", type: "agent" },
          files,
          integrity,
        },
      ],
    ]),
    integrity: bundleIntegrity(
      new Map([[identity, { path: "packages/@appstrate/in-container/0.0.0/", integrity }]]),
    ),
  };
}

/**
 * Last-resort operator diagnostic for fatal paths whose normal reporting
 * channel (the sink POST) failed or was deliberately skipped. Under
 * Firecracker the serial console captures stderr, so this single line is
 * the only recoverable trace of WHY the container died. Blocking write
 * (`writeSync(2, …)`): async stdout/stderr writes get truncated by the
 * `process.exit` that immediately follows (same rationale as the exit
 * marker's synchronous write). `exitCode` is the code the caller is about
 * to exit with — `null` when the caller may not exit (non-fatal emitError).
 * Only pass error messages already destined for the sink — never secrets.
 */
function lastResortStderr(exitCode: number | null, reason: string, cause?: unknown): void {
  try {
    const line =
      `[runtime-pi fatal] ${new Date().toISOString()}` +
      (exitCode === null ? "" : ` exit=${exitCode}`) +
      ` ${reason}` +
      (cause === undefined ? "" : ` — cause: ${getErrorMessage(cause)}`);
    writeSync(2, `${line.replace(/\r?\n/g, " | ")}\n`);
  } catch {
    // stderr itself is gone — nothing left to try.
  }
}

// --- 0. Env validation + sink bootstrap ---
// Every runtime-pi invocation MUST come from a platform run that has
// already minted sink credentials + inserted a pending run row. We
// validate the full env contract once, fail-fast with a structured
// list of issues (better DX than first-failure), and bail out before
// touching any heavy module.

let env: ReturnType<typeof parseRuntimeEnv>;
try {
  env = parseRuntimeEnv(process.env);
} catch (err) {
  // Before the sink is live, stderr is the only channel — the platform's
  // container monitor will synthesise a `failed` finalize from the exit
  // code so the run record still reaches a terminal state. Blocking write:
  // an async one would be truncated by the exit that follows.
  if (err instanceof RuntimeEnvError) {
    lastResortStderr(1, err.message);
  } else {
    lastResortStderr(1, "env validation failed", err);
  }
  process.exit(1);
}

const AGENT_RUN_ID = env.runId;

const sink = new HttpSink({
  url: env.sink.url,
  finalizeUrl: env.sink.finalizeUrl,
  runSecret: env.sink.secret,
  traceparent: env.traceparent,
  // Sink traffic rides the sidecar forward proxy, which boots in parallel —
  // the very first POST (sequence 1, fired non-blocking below) can land
  // before the proxy binds. A tight initial retry (vs the 500 ms default)
  // shrinks the window during which later events sit in the platform's
  // out-of-order buffer waiting for sequence 1. More attempts + a 2 s cap
  // keep the total window bounded: sleeps are 0.12+0.24+0.48+0.96+1.92+2+2
  // ≈ 7.7 s (vs ~3.5 s at the 4×500ms default) — enough to outlive a slow
  // proxy bind, without inflating the fatal path: `die()` (one error POST +
  // one finalize POST, each exhausting retries when the platform is
  // unreachable) holds the container ~15 s before exit; the uncapped 30 s
  // default would hold it ~30 s, delaying the platform's exit-synthesized
  // failure the user is waiting on.
  initialBackoffMs: 120,
  maxAttempts: 8,
  maxBackoffMs: 2000,
});

// --- 0a. Stdout-JSONL bridge ---
// See `@appstrate/afps-runtime/sinks/stdout-bridge` for the full design
// rationale. In short: system tools still emit canonical events via
// `process.stdout.write`; we intercept those lines, fold them into an
// aggregator together with PiRunner's session events, and merge the
// aggregate into the finalize POST so `result.output`, `result.pinned`,
// and `result.memories` are complete when the platform ingests the run.
const bridge = attachStdoutBridge({ sink, runId: AGENT_RUN_ID });
const bridgedSink = bridge.sink;

// --- 0b. Document publishing (run → platform) ---
// sha256s this run has published, shared by the `publish_document` tool and
// the end-of-run outputs sweep so a file published explicitly is not swept
// again. The uploader streams a workspace file to POST /api/runs/:id/documents,
// signed with the same run HMAC as the workspace provisioning fetches.
const publishedDocumentShas = new Set<string>();
const uploadRunDocument = createRunDocumentUploader({
  sinkUrl: env.sink.url,
  sinkSecret: env.sink.secret,
  workspace: env.workspaceDir,
  publishedShas: publishedDocumentShas,
});

/**
 * Emit a best-effort `appstrate.error` event for a bootstrap failure. We
 * swallow sink errors here — the caller is about to `process.exit(1)` and
 * the platform's container-monitor will synthesise a finalize on exit.
 */
async function emitError(message: string, data?: Record<string, unknown>): Promise<void> {
  try {
    await sink.handle({
      type: "appstrate.error",
      timestamp: Date.now(),
      runId: AGENT_RUN_ID!,
      message,
      ...(data !== undefined ? { data } : {}),
    });
  } catch (sinkErr) {
    // The sink POST failed — let the container exit with non-zero code.
    // Finalize synthesis on the server will record the failure. The platform
    // never saw this error, so leave a last-resort trace on stderr.
    lastResortStderr(null, `error event POST failed — original error: ${message}`, sinkErr);
  }
}

/**
 * Fatal bootstrap failure. Emits one `appstrate.error`, attempts to
 * finalize the run as `failed`, and exits. `finalize` is best-effort —
 * server-side synthesis covers the case where even finalize POST fails.
 */
async function die(message: string, data?: Record<string, unknown>): Promise<never> {
  await emitError(message, data);
  try {
    const failureResult = emptyRunResult();
    failureResult.error = { message };
    failureResult.status = "failed";
    await sink.finalize(failureResult);
  } catch (finalizeErr) {
    // fall through — server-side synthesis covers us, but leave a trace.
    lastResortStderr(1, `failed-finalize POST failed — dying on: ${message}`, finalizeErr);
  }
  process.exit(1);
}

/**
 * Emit a boot breadcrumb into the run log — best-effort. Observability must
 * never abort a run, so sink hiccups are swallowed here (unlike `emitError`,
 * whose failures the bootstrap path escalates). The FIRST breadcrumb doubles
 * as the run's `pending → running` transition (the platform flips on any first
 * event), so emitting one as early as the sink allows closes the otherwise
 * silent gap between container start and the first tool call.
 *
 * Always carries `data` (at minimum `{ boot: true }`): the log viewer
 * coalesces consecutive *data-less* `progress` events into one block (to fold
 * an agent's freeform stdout lines together). These are discrete phase markers,
 * not stdout — the `data` marker keeps each on its own log entry.
 */
async function progress(message: string, data?: Record<string, unknown>): Promise<void> {
  await emitBootProgress(bridgedSink, AGENT_RUN_ID!, message, {
    data: { boot: true, ...data },
  }).catch(() => {});
}

/**
 * Cap on how long we wait for the sidecar's boot report. Generous: it
 * exceeds the sidecar's per-integration MCP connect deadline (30 s) plus
 * headroom for a few sequential integrations, so a report that never
 * arrives means an integration boot genuinely hung — which we treat as a
 * fatal "did not start as declared", not a transient blip.
 */
const BOOT_REPORT_DEADLINE_MS = 60_000;

/**
 * Fetch the sidecar's integration boot report — the authoritative spawn/
 * connect outcome for every declared integration, plus the per-phase
 * breadcrumbs the dashboard renders. The endpoint awaits the sidecar's boot
 * pass before answering, so a successful response is final.
 *
 * Reachable on the same per-run network the MCP client just handshook over;
 * a connection-level failure here is almost always a momentary race, so we
 * retry briefly. We do NOT swallow a definitive failure: the run must abort
 * when integration health can't be confirmed (the platform contract — an
 * integration that didn't launch as declared fails the run, every tier).
 *
 * No auth header: the agent container holds no run token by design (the
 * sidecar is the only party that can call back to the platform), so the
 * endpoint mirrors `/mcp`'s network-isolation posture.
 */
async function fetchIntegrationBootReport(
  sidecarUrl: string,
): Promise<{ report: IntegrationBootReport } | { error: string }> {
  const url = `${sidecarUrl.replace(/\/$/, "")}/integrations/boot-report`;
  let lastError = "unknown error";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), BOOT_REPORT_DEADLINE_MS);
    try {
      const res = await fetch(url, { signal: ac.signal });
      if (res.ok) return { report: (await res.json()) as IntegrationBootReport };
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = getErrorMessage(err);
    } finally {
      clearTimeout(timer);
    }
    process.stderr.write(`[boot-report] ${lastError} (attempt ${attempt}/3)\n`);
    if (attempt < 3) await new Promise((r) => setTimeout(r, 250 * attempt));
  }
  return { error: lastError };
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

// --- 1. Init workspace ---

const WORKSPACE = env.workspaceDir;

/** Create a minimal valid git repo via filesystem (avoids 3 subprocess spawns). */
async function initGitWorkspace(): Promise<void> {
  const gitDir = `${WORKSPACE}/.git`;
  await fs.mkdir(`${gitDir}/refs`, { recursive: true });
  await Promise.all([
    fs.writeFile(`${gitDir}/HEAD`, "ref: refs/heads/main\n"),
    fs.writeFile(`${gitDir}/config`, "[user]\n\temail = pi@appstrate.local\n\tname = Pi\n"),
  ]);
}

// --- 2. Load tools ---

const extensionFactories: ExtensionFactory[] = [];

// Runtime context exposed to custom tools as the 4th `execute` argument.
// Assigned once tool wiring runs (the sidecar Phase-C block or the no-sidecar
// `else` branch); the closure provider is read at every `execute` invocation,
// so factories registered earlier still see the wired ctx by the time a tool
// actually runs.
//
// NOT a definite-assignment (`!`) binding: a `!` would let a stray read
// BEFORE wiring completes hand out `undefined` typed as a live ctx (silent
// null-deref); the guarded provider throws a clear error instead.
let appstrateRuntimeCtx: AppstrateToolCtx | undefined;
const appstrateCtxProvider: AppstrateCtxProvider = () => {
  if (!appstrateRuntimeCtx) {
    throw new Error(
      "appstrate runtime tool context is not wired yet " +
        "(tool executed before tool wiring completed). This is a runtime wiring bug.",
    );
  }
  return appstrateRuntimeCtx;
};
const loadedRuntimeIds = new Set<string>();

/**
 * Load platform-shipped extensions from the container's `/runtime/extensions/`
 * directory. These are Pi-bundled tools (e.g. built-in primitives) that do
 * not travel inside the AFPS bundle — kept here because the shared
 * `prepareBundleForPi` intentionally only handles bundle-scoped tools.
 */
async function loadExtensionsFromDir(dir: string, label: string) {
  if (!(await exists(dir))) return;
  const entries = (await fs.readdir(dir)).filter((e) => e.endsWith(".ts"));

  const results = await Promise.allSettled(
    entries
      .filter((e) => !loadedRuntimeIds.has(e.replace(/\.ts$/, "")))
      .map(async (entry) => {
        const id = entry.replace(/\.ts$/, "");
        const mod = await import(path.join(dir, entry));
        const factory = mod.default;
        if (typeof factory !== "function") {
          await emitError(
            `Extension '${id}' (${label}): default export is not a function (got ${typeof factory})`,
          );
          return;
        }
        extensionFactories.push(
          wrapExtensionFactory(factory as ExtensionFactory, id, appstrateCtxProvider),
        );
        loadedRuntimeIds.add(id);
      }),
  );

  for (const result of results) {
    if (result.status === "rejected") {
      await emitError(`Failed to load extension (${label}): ${result.reason}`);
    }
  }
}

// --- 2a. Phase A: git init + load AFPS bundle in parallel ---

// Earliest possible event: the sink is live and the heavy ESM imports + Bun
// cold start are behind us. `performance.now()` is measured from process entry
// (timeOrigin), so it quantifies the cold-start gap the dashboard otherwise
// shows as dead air before the run goes `running`.
//
// Fire-and-forget: this POST rides the sidecar's forward proxy (the agent's
// only route out), which boots in parallel (#406) — awaiting it serializes
// the whole boot behind the proxy coming up (~2s of HttpSink backoff on a
// cold host). Provisioning below retries through the same proxy, so nothing
// downstream depends on this event having landed. Ordering is safe: the sink
// stamped this event sequence 1 at emit time, and the ingestion endpoint
// buffers any later-sequence arrivals until it lands, then drains in order
// (run-event-ingestion.ts) — worst case the dashboard shows the boot trail
// as one burst instead of a trickle, exactly what the old awaited POST
// produced anyway (nothing was emitted at all until it succeeded).
void progress(`runtime starting (${Math.round(performance.now())}ms cold start)`, {
  coldStartMs: Math.round(performance.now()),
});

// Per-phase cold-start durations, folded into the "runtime ready" breadcrumb
// so a slow boot is attributable (provisioning vs bundle prepare vs SDK import
// vs MCP connect) instead of a single opaque total.
const phaseTimings: Record<string, number> = {};

// Warm the heavy Pi SDK now (non-awaited) so its ~200ms module eval overlaps
// the network-bound provisioning below instead of landing on the pre-session
// boot path. `@mariozechner/pi-coding-agent` is dynamically imported by
// `PiRunner` at session-build time; ESM caches the module, so this kick-off
// turns that later `await` into a no-op.
const sdkImportStart = performance.now();
// The `.catch(() => null)` is attached at creation so the handle is never
// momentarily unguarded: if the dynamic import rejects before we await it (~400
// lines below) it would otherwise surface as an unhandled rejection. Swallowing
// here is safe — the authoritative load happens inside `PiRunner.executeSession`
// (ESM caches the errored module, so its `await loadPiCodingAgentSdk()` re-throws
// and the run fails through the normal error path). A failed warm-up resolves to
// `null` and records nothing; `sdkImportMs` is captured inside the resolve step
// below, at actual import completion — not at the late await (~400 lines down),
// which in the nominal case fires after provisioning already overlapped the load
// and would misattribute the whole boot window to the import.
const piSdkWarmup = loadPiCodingAgentSdk()
  .then((sdk) => {
    phaseTimings.sdkImportMs = Math.round(performance.now() - sdkImportStart);
    return sdk;
  })
  .catch(() => null);

const provisionStart = performance.now();

// Self-provision the workspace before anything reads it: the AFPS bundle
// (fatal on any miss — see provisionWorkspace) and the input documents
// (streamed per-file to `documents/<name>`; absent is fine). Run in parallel —
// they write disjoint paths (bundle → workspace root, documents →
// `documents/`), share no state, and neither is read until after both resolve,
// so overlapping their fetches shaves cold-start latency. On failure either
// one calls `die()` (process.exit), so the first fault wins and the other is
// abandoned with the process.
const provisionDeps: ProvisionDeps = {
  sinkUrl: env.sink.url,
  sinkSecret: env.sink.secret,
  workspace: WORKSPACE,
  die,
};
await Promise.all([provisionWorkspace(provisionDeps), provisionDocuments(provisionDeps)]);

const packagePath = path.join(WORKSPACE, "agent-package.afps");
const hasPackage = await exists(packagePath);

const [, bundle] = await Promise.all([
  initGitWorkspace(),
  hasPackage ? readBundleFromFile(packagePath) : Promise.resolve(null),
]);

phaseTimings.provisioningMs = Math.round(performance.now() - provisionStart);
await progress(
  hasPackage ? "workspace initialized · agent package read" : "workspace initialized",
  { provisioningMs: phaseTimings.provisioningMs },
);

// --- 2b. Phase B: materialise .pi/ layout + dynamic-import tools ---

const bundlePrepareStart = performance.now();

if (bundle) {
  try {
    await prepareBundleForPi(bundle, { workspaceDir: WORKSPACE });

    // Fail-loud safety net (issue #549): verify every skill the bundle
    // carries actually landed under `.pi/skills/<id>`. Before agent
    // self-provisioning, a dropped bundle degraded silently — the agent
    // booted onto an empty workspace and only an easily-missed log line
    // hinted at it. Now a skill that the bundle declares but that did not
    // materialise surfaces as an `appstrate.error` breadcrumb, so the
    // regression cannot hide again.
    const missingSkills: string[] = [];
    for (const [identity, pkg] of bundle.packages) {
      if (identity === bundle.root) continue;
      if ((pkg.manifest as { type?: unknown }).type !== "skill") continue;
      const parsed = parsePackageIdentity(identity);
      if (!parsed) continue;
      if (!(await exists(path.join(WORKSPACE, ".pi", "skills", parsed.packageId)))) {
        missingSkills.push(parsed.packageId);
      }
    }
    if (missingSkills.length > 0) {
      await emitError(
        `Skill(s) declared by the agent did not materialise: ${missingSkills.join(", ")}`,
        { missingSkills },
      );
    }

    // Fire-and-forget cleanup of the original AFPS; no longer needed once the
    // Pi SDK is up. (prepareBundleForPi is skills-only — no scratch dir.)
    void fs.unlink(packagePath).catch(() => {});
  } catch (err) {
    await emitError(`Failed to prepare agent package: ${getErrorMessage(err)}`);
  }
}

await loadExtensionsFromDir("/runtime/extensions", "runtime");

phaseTimings.bundlePrepareMs = Math.round(performance.now() - bundlePrepareStart);
await progress(
  `bundle loaded (${extensionFactories.length} extension${extensionFactories.length === 1 ? "" : "s"})`,
  {
    bundleLoaded: bundle !== null,
    extensions: extensionFactories.length,
    bundlePrepareMs: phaseTimings.bundlePrepareMs,
  },
);

// The agent's selected runtime tools (`manifest.runtime_tools`), read once from
// the root package manifest. Reused by the no-sidecar extension registration,
// the `publish_document` gate, and the PiRunner's terminal-tool decision.
const declaredRuntimeTools: string[] = bundle
  ? ((bundle.packages.get(bundle.root)?.manifest as { runtime_tools?: string[] } | undefined)
      ?.runtime_tools ?? [])
  : [];

// --- 2c. Phase C: wire sidecar-backed tools via MCP ---
// Every sidecar-backed capability is surfaced as a typed Pi tool whose
// implementation forwards to the sidecar's MCP `tools/call` endpoint:
//   - `{ns}__api_call({ method, target, … })` — credential-injecting proxy.
//   - `run_history` — recent past-run metadata.
//   - `recall_memory({ q?, limit? })` — archive memory store.
// The agent LLM never sees the sidecar URL; the contract ("agent never
// talks to the sidecar directly") is enforced via the env-var deletion
// in 2d below.

const sidecarUrl = env.sidecarUrl;

// Shared runtime-event drainer (one per run, in-memory cursor). The sidecar
// executes each runtime tool ONCE and journals its canonical events; the Pi
// runner drains this on its single sink after each forwarded tool call, plus
// a retrying final drain. One instance so the cursor stays consistent across
// intermediate + final drains. Undefined when no sidecar is attached (no
// journal to drain — the in-process Pi extension path emits its own events).
const runtimeDrainer: RuntimeEventDrainer | undefined = sidecarUrl
  ? createRuntimeEventDrainer({
      url: `${sidecarUrl.replace(/\/$/, "")}/runtime-events`,
      headers: { Host: "sidecar" },
      logger: {
        warn: (msg, data) =>
          process.stdout.write(
            `${JSON.stringify({ level: "warn", event: msg, ...(data ?? {}) })}\n`,
          ),
        error: (msg, data) =>
          process.stdout.write(
            `${JSON.stringify({ level: "error", event: msg, ...(data ?? {}) })}\n`,
          ),
      },
    })
  : undefined;

// When no sidecar is attached (no integrations + static API
// key), the agent runs without MCP-backed tools. The platform wires
// MODEL_BASE_URL directly to the upstream provider; the LLM only sees
// the agent's bundle tools + runtime extensions.
let mcpClient: AppstrateMcpClient | undefined;
if (sidecarUrl) {
  {
    await progress("connecting to sidecar");
    const mcpConnectStart = performance.now();
    try {
      // Retry the initial MCP handshake — the platform now starts the agent
      // in parallel with sidecar boot (issue #406), so the sidecar's /mcp
      // may briefly answer ECONNREFUSED / ENOTFOUND while the container is
      // still wiring its listener and the Docker DNS alias is propagating.
      // AWS-style full jitter (50ms → 1s) absorbs the race without
      // pessimising the warm-path; the default 60s deadline covers
      // worst-case cold container pulls (#406 acceptance criteria: 20–45s
      // boots are routine). Operators on slow registries can widen via
      // `APPSTRATE_MCP_CONNECT_DEADLINE_MS`.
      // The sidecar's /mcp endpoint gates inbound requests by the per-run
      // Docker network + Host-header check (`validateMcpHostHeader`); it does
      // NOT verify a bearer token, so the agent connects unauthenticated. (An
      // earlier RUN_TOKEN-as-bearer path was wired but never validated — dropped.)
      mcpClient = await createMcpHttpClient(`${sidecarUrl.replace(/\/$/, "")}/mcp`, {
        clientInfo: { name: "appstrate-runtime-pi", version: "1.0" },
        // #779 annex — operator-tunable per-call tool timeout (absent →
        // SDK default). The same `APPSTRATE_MCP_TOOL_TIMEOUT_MS` knob is
        // honoured sidecar-side, so both legs of an integration tool call
        // share one budget.
        ...(env.mcpToolTimeoutMs !== undefined ? { defaultTimeoutMs: env.mcpToolTimeoutMs } : {}),
        retry: {
          deadlineMs: env.mcpConnectDeadlineMs,
          baseMs: 50,
          capMs: 1_000,
          onRetry: ({ url, attempt, delayMs, errorCode, error }) => {
            // pino-shaped JSON line — stdout is captured by the platform's
            // container log buffer, so this lands on the same audit trail
            // operators use for run diagnostics.
            process.stdout.write(
              `${JSON.stringify({
                level: "warn",
                event: "mcp_connect_retry",
                url,
                attempt,
                delayMs,
                errorCode: errorCode ?? null,
                error: error instanceof Error ? error.message : String(error),
              })}\n`,
            );
          },
        },
      });
    } catch (err) {
      await emitError(`Failed to connect MCP client to sidecar: ${getErrorMessage(err)}`);
      process.exit(1);
    }

    phaseTimings.mcpConnectMs = Math.round(performance.now() - mcpConnectStart);
    await progress("MCP connected", { mcpConnectMs: phaseTimings.mcpConnectMs });

    try {
      // `buildMcpDirectFactories` registers `run_history` and
      // `recall_memory`, plus one forwarding factory per namespaced
      // integration tool (including the generic `{ns}__api_call`). Runtime
      // tools (log/note/pin/output) are executed once by the sidecar and
      // journaled; the drainer pulls them on the run sink after each forwarded
      // call — never trusted from `_meta`.
      //
      // Pi drains each tool call inline in `execute()` right after `callTool`
      // resolves — the sidecar appends the events synchronously inside the
      // wrapped handler BEFORE responding, so the per-call drain always captures
      // them in time (no "events land after the stream ends" gap to
      // backstop). What the per-call drain CANNOT cover is a
      // transient localhost failure of the LAST call's single best-effort drain
      // (no subsequent call retries it). The retrying final drain for that case
      // is injected via `piEventSink` (below): PiRunner owns its finalize, so a
      // drain placed after `runner.run()` would be too late — wrapping the sink
      // runs it BEFORE the stdout-bridge merges its aggregate into the POST.
      const factories = await buildMcpDirectFactories({
        mcp: mcpClient,
        runId: AGENT_RUN_ID,
        workspace: WORKSPACE,
        ...(runtimeDrainer ? { drainer: runtimeDrainer } : {}),
        emit: (event) => {
          void bridgedSink.handle(event as RunEvent);
        },
      });
      extensionFactories.push(...factories);

      // Wire the tool-side runtime context (4th `execute` arg). Integrations
      // expose their own namespaced tools (including the generic
      // `{ns}__api_call`) directly to the LLM, so the only capability the ctx
      // carries is `readResource` — it resolves any MCP `resource_link` an
      // integration tool may return for spilled blobs.
      const mcp = mcpClient;
      appstrateRuntimeCtx = {
        readResource: async (uri) => {
          const result = await mcp.readResource({ uri });
          return result as Awaited<ReturnType<AppstrateToolCtx["readResource"]>>;
        },
      };
    } catch (err) {
      await emitError(`Failed to wire MCP-backed tools: ${getErrorMessage(err)}`);
      process.exit(1);
    }
  } // end sidecar tool wiring

  // --- 2c-bis. Integration boot gate + per-phase observability ---
  // The sidecar booted each declared integration in parallel with this
  // container. Fetch its authoritative boot report (uses the captured
  // `sidecarUrl` const — the env var is deleted just below), relay every
  // per-phase breadcrumb into the run log, and ABORT the run if any declared
  // integration failed to start — the platform contract, every tier. A run
  // that can't even confirm integration health aborts too.
  const bootResult = await fetchIntegrationBootReport(sidecarUrl);
  if ("error" in bootResult) {
    await die(`Could not verify integration boot status: ${bootResult.error}`);
  } else {
    const bootReport = bootResult.report;
    for (const crumb of bootReport.breadcrumbs) {
      await emitBootProgress(bridgedSink, AGENT_RUN_ID!, crumb.message, {
        level: crumb.level,
        ...(crumb.data ? { data: crumb.data } : {}),
      }).catch(() => {});
    }
    if (!bootReport.ok) {
      const summary = bootReport.failed.map((f) => `${f.integrationId} (${f.error})`).join("; ");
      await die(
        `Integration boot failed — ${bootReport.failed.length} of ${bootReport.declared} ` +
          `integration(s) did not start: ${summary}`,
        { failed: bootReport.failed },
      );
    }
  }

  // --- 2d. Zero-knowledge enforcement ---
  // The sidecar URL is a runtime implementation detail. Now that the
  // MCP client owns the only path to the sidecar, remove the env var
  // so the Pi bash extension cannot leak it via `echo $SIDECAR_URL` or
  // similar. Safe: no downstream consumer in this process reads
  // SIDECAR_URL past this point.
  delete process.env.SIDECAR_URL;
} else {
  // No sidecar attached (skip-sidecar: no integrations + static API key).
  // The platform runtime tools (output/log/note/pin) the agent
  // selected are normally served by the sidecar over MCP; with no sidecar
  // we register the SAME tool definitions (`@appstrate/core/runtime-tool-defs`)
  // as Pi extensions in-process. Their canonical events are re-emitted into
  // the run sink by the wrapper (default stdout-JSONL → the stdout bridge).
  let outputSchema: Record<string, unknown> | null = null;
  if (process.env.OUTPUT_SCHEMA) {
    try {
      outputSchema = JSON.parse(process.env.OUTPUT_SCHEMA) as Record<string, unknown>;
    } catch {
      outputSchema = null;
    }
  }
  extensionFactories.push(
    ...buildRuntimeToolExtensions({
      ...(declaredRuntimeTools.length > 0 ? { runtimeTools: declaredRuntimeTools } : {}),
      outputSchema,
      emit: (event) => {
        void bridgedSink.handle(event as RunEvent);
      },
    }),
  );

  // No sidecar attached — wire a stub tool ctx whose only capability
  // (`readResource`) rejects. Integrations expose their own {ns}__api_call
  // MCP tools when a sidecar is present; without one a misconfigured bundle
  // still gets a clear error rather than a null-deref.
  appstrateRuntimeCtx = {
    readResource: async (uri) => {
      throw new Error(
        `Tool tried to read MCP resource '${uri}' but this run was launched without a sidecar.`,
      );
    },
  };
}

// --- 2e. publish_document runtime tool (opt-in via manifest.runtime_tools) ---
// Unlike the five pure event-emitter runtime tools (served by the sidecar over
// MCP, or registered in-process on the no-sidecar path), `publish_document`
// performs an HTTP upload back to the platform — so it is ALWAYS registered
// in-process here (the sidecar has no path to the documents route), gated on
// the agent selecting it. It carries the run's HMAC signer via the injected
// `uploadRunDocument`; its `document.published` event rides the bridged sink.
if (declaredRuntimeTools.includes("publish_document")) {
  extensionFactories.push(
    buildPublishDocumentExtension({
      uploader: uploadRunDocument,
      emit: (event) => {
        void bridgedSink.handle(event as RunEvent);
      },
    }),
  );
}

// --- 3. Model + system prompt from env ---

const api = env.modelApi;
const modelId = env.modelId;
const systemPrompt = env.agentPrompt;

const model: Model<Api> = {
  id: modelId,
  name: modelId,
  api: api as Api,
  // Pi SDK AuthStorage key, derived from the api shape. The runner reads
  // this field directly to register + resolve the API key.
  provider: deriveProviderFromApi(api),
  baseUrl: env.modelBaseUrl ?? "",
  reasoning: env.modelReasoning,
  input: [...env.modelInput],
  cost: env.modelCost,
  contextWindow: env.modelContextWindow,
  maxTokens: env.modelMaxTokens,
};

// --- 4. Build ExecutionContext from env ---

const context: ExecutionContext = {
  runId: AGENT_RUN_ID,
  input: env.agentInput,
  memories: [],
  config: {},
  // When the platform forwarded a budget, the runner enforces it itself
  // (watchdog from the run-loop start, boot excluded) and finalizes a
  // first-class `timeout` terminal — instead of waiting for the platform's
  // safety-net container kill, which can only surface a generic abort.
  ...(env.timeoutSeconds !== undefined ? { timeoutSeconds: env.timeoutSeconds } : {}),
};

// --- 5. Resolve bundle for PiRunner (fallback to synthetic when no .afps) ---
// PiRunner needs a Bundle; when no agent-package.afps was present, the
// platform pre-installed files directly so we hand it a minimal stub
// (built via the same helper used in Phase C).
const runnerBundle: Bundle = bundle ?? buildInContainerBundle(systemPrompt);

// --- 6. Signal runtime readiness ---
//
// Emitted *after* the bundle is loaded + providers wired, but *before*
// the PiRunner loop starts. This is the honest "ready to talk to the
// LLM" signal — Docker create + pull + workspace init + dynamic tool
// imports are all done. It also gives the dashboard a first log line
// immediately on cold starts (Docker pull can take seconds) instead of
// a silent gap between `pending` and the first tool call.
//
// `performance.now()` is measured from `performance.timeOrigin` (the
// wall-clock instant the process started), so it folds in Bun startup
// + ESM import evaluation (the heavy module loading at the top of this
// file) on top of the post-import boot work. An earlier `Date.now()`
// timer declared as a top-level const missed all of that — ES modules
// evaluate every `import` before any top-level statement runs, so the
// timer started only after the slow part was already done and reported
// an artificially low duration vs. the user-perceived gap.
// The Pi SDK warm-up was kicked off during provisioning; awaiting it here keeps
// "runtime ready" honest — the module that talks to the LLM is actually loaded —
// while folding its cost into the overlap window rather than the post-ready
// path. The warm-up handle swallowed its rejection at creation (resolves to
// `null`) purely to avoid an unhandled-rejection window; a `null` therefore
// means the SDK CANNOT load, and emitting "runtime ready" anyway would
// reclassify a deterministic image defect as a mid-run session failure (the
// pre-lazy static import failed the container at eval time — before any
// event). Re-awaiting the loader surfaces the ESM-cached rejection with its
// real message, and `die()` restores the fail-fast contract: one
// `appstrate.error` + a failed finalize instead of a lying ready signal.
if (piSdkWarmup && (await piSdkWarmup) === null) {
  try {
    await loadPiCodingAgentSdk();
  } catch (err) {
    await die(`Pi SDK failed to load — runtime image is unusable: ${getErrorMessage(err)}`);
  }
}

await emitRuntimeReady(bridgedSink, AGENT_RUN_ID, {
  bundleLoaded: bundle !== null,
  extensions: extensionFactories.length,
  bootDurationMs: performance.now(),
  phaseTimings,
});

// --- 6a. Liveness keep-alive ---
//
// Start the runner-side heartbeat against POST {SINK_URL}/heartbeat.
// The server bumps `runs.last_heartbeat_at` on every ping; the stall
// watchdog reads that column to detect a crashed container (network
// partition, SIGKILL, Docker daemon drop). This path is identical to
// the CLI's — same helper, same endpoint, same HMAC auth — so platform
// and remote runs share one liveness mechanism.
const heartbeat = startSinkHeartbeat({
  url: `${env.sink.url.replace(/\/$/, "")}/heartbeat`,
  runSecret: env.sink.secret,
  intervalMs: env.heartbeatIntervalMs,
  onError: (err) => {
    // Non-fatal — stall watchdog is the backstop. Keep it on stderr so
    // container log forwarding captures it without polluting the event
    // stream.
    process.stderr.write(`[heartbeat] ${getErrorMessage(err)}\n`);
  },
});

// --- 7. Run via the Pi engine ---
//
// The runner calls `sink.finalize(result)` on the happy path and its own
// internal error path. Any error escaping here is a bootstrap-level failure
// (before the runner reached its own try/catch) — we catch it, emit an error +
// finalize, then exit non-zero so the container monitor also records the crash.

/** Construct the Pi runner (every run). */
function buildPiRunner(): PiRunner {
  // When the agent selected the `output` runtime tool, a successful call is
  // the run's semantic end — stop the SDK loop there instead of paying one
  // more LLM round-trip for a trailing text-only turn whose content the
  // communication contract discards anyway. Gated on the manifest selection
  // so a bundle-defined tool that happens to be named `output` (no
  // `runtime_tools` opt-in) keeps the SDK's natural stop.
  return new PiRunner({
    model,
    apiKey: env.modelApiKey,
    systemPrompt,
    cwd: WORKSPACE,
    agentDir: "/tmp/pi-agent",
    extensionFactories,
    authStoragePath: "/tmp/pi-auth/auth.json",
    ...(declaredRuntimeTools.includes("output") ? { terminalTools: ["output"] } : {}),
  });
}

/** Compiled fallback when the platform did not forward its effective cap. */
const DEFAULT_DOCUMENT_MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * Client-side per-file bound for the outputs sweep — the platform's EFFECTIVE
 * `DOCUMENT_MAX_FILE_BYTES` (forwarded by the run-launcher), falling back to the
 * compiled 100 MiB default when absent/unparseable. The server is the
 * authoritative gate (it cuts an over-cap stream mid-flight); this just avoids
 * streaming a file that is certain to be rejected. Reading the forwarded value
 * keeps the two in lockstep — an operator who raises the platform cap no longer
 * sees large deliverables silently skipped here.
 */
const OUTPUTS_SWEEP_MAX_FILE_BYTES = ((): number => {
  const raw = process.env.DOCUMENT_MAX_FILE_BYTES;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_DOCUMENT_MAX_FILE_BYTES;
})();

/**
 * Auto-publish everything under `workspace/outputs/` that was not already
 * published explicitly. Runs at finalize time, BEFORE the finalize event is
 * posted, so the swept documents surface as run events. Best-effort — a sweep
 * failure logs a warning and never blocks finalize (regardless of whether the
 * `publish_document` tool was enabled).
 */
async function runOutputsSweep(): Promise<void> {
  await sweepOutputs({
    uploader: uploadRunDocument,
    workspace: WORKSPACE,
    publishedShas: publishedDocumentShas,
    maxFileBytes: OUTPUTS_SWEEP_MAX_FILE_BYTES,
    emit: (event) => {
      void bridgedSink.handle(event as RunEvent);
    },
    logWarn: (message, data) =>
      process.stdout.write(
        `${JSON.stringify({ level: "warn", event: message, ...(data ?? {}) })}\n`,
      ),
  }).catch((err) => {
    // sweepOutputs already swallows per-file failures; this guards the scan
    // itself so a sweep fault can never abort finalize.
    process.stderr.write(`[outputs-sweep] ${getErrorMessage(err)}\n`);
  });
}

// Pi-path finalize wrapper. Two things must happen before the finalize POST:
//   1. Final runtime-event drain (sidecar path only) — Pi drains each tool call
//      inline (see the factories block above), but the LAST call's single
//      best-effort drain has no subsequent call to retry a transient localhost
//      failure, so we drain-until-empty + bounded retry through the SAME bridged
//      sink the per-call drains use.
//   2. The outputs sweep — auto-publish `workspace/outputs/` deliverables so
//      their `document.published` events ride the run stream before it closes.
// PiRunner owns its finalize, so wrapping the sink is the only injection point
// that runs BEFORE the stdout-bridge merges its aggregate into the finalize POST.
const piEventSink: typeof bridgedSink = {
  handle: (event) => bridgedSink.handle(event),
  finalize: async (result) => {
    if (runtimeDrainer) {
      await drainAndEmitInto({
        drainer: runtimeDrainer,
        emit: (e) => bridgedSink.handle(e as RunEvent),
        now: Date.now,
        runId: AGENT_RUN_ID!,
        final: true,
      });
    }
    await runOutputsSweep();
    await bridgedSink.finalize(result);
  },
};

const startTime = Date.now();

// Graceful shutdown: a container stop sends SIGTERM (then SIGKILL after a grace
// period). Convert it to an AbortSignal threaded into runner.run so the runner
// can unwind its cleanup (cancelling tool calls) BEFORE the hard kill lands —
// instead of being torn down mid-write.
const runAbort = new AbortController();
const onTerminate = () => runAbort.abort();
process.once("SIGTERM", onTerminate);
process.once("SIGINT", onTerminate);

try {
  const runner = buildPiRunner();

  await runner.run({
    bundle: runnerBundle,
    context,
    eventSink: piEventSink,
    signal: runAbort.signal,
  });
  heartbeat.stop();
  await mcpClient?.close().catch(() => {});
  process.exit(0);
} catch (err) {
  heartbeat.stop();
  await mcpClient?.close().catch(() => {});

  // External abort (SIGTERM/SIGINT = platform timeout safety-net or a user
  // cancel). The runner already honours this by rethrowing WITHOUT finalizing
  // (`finalizeThrownFailure`'s abort-rethrow arm) — and only the platform knows
  // WHICH terminal cause it was. Finalizing `failed` + the SDK's generic
  // "operation was aborted" message here would win the finalize CAS and mask
  // the platform's authoritative `timeout`/`cancelled` synthesis. So we must
  // NOT finalize (nor emit a spurious adapter_error): just exit non-zero and
  // let `execute-background` synthesise the real terminal state.
  if (runAbort.signal.aborted) {
    lastResortStderr(1, "run aborted (SIGTERM/SIGINT) — finalize intentionally skipped", err);
    process.exit(1);
  }

  const message = getErrorMessage(err);
  await emitError(message);
  try {
    const failureResult = emptyRunResult();
    failureResult.error = { message, stack: err instanceof Error ? err.stack : undefined };
    failureResult.status = "failed";
    failureResult.durationMs = Date.now() - startTime;
    await sink.finalize(failureResult);
  } catch (finalizeErr) {
    // swallow — container exit code + server-side synthesis cover us,
    // but leave a last-resort trace for the serial console.
    lastResortStderr(1, `failed-finalize POST failed — run error: ${message}`, finalizeErr);
  }
  process.exit(1);
}
