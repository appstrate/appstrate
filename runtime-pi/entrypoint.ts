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
import * as path from "node:path";
import type { ExtensionFactory, Api, Model } from "./pi-sdk.ts";
import {
  PiRunner,
  prepareBundleForPi,
  buildRuntimeToolExtensions,
  deriveProviderFromApi,
  emitRuntimeReady,
  emitBootProgress,
  startSinkHeartbeat,
  type AppstrateToolCtx,
  type AppstrateCtxProvider,
} from "@appstrate/runner-pi";
import { getErrorMessage } from "@appstrate/core/errors";
// The subscription runners (claude/codex) are DYNAMICALLY imported inside their
// build functions, gated by RUN_ENGINE — a `pi` run never loads them, and a
// slim OSS image built without these packages (ISO6) still boots for pi. Only
// the types are statically referenced (erased at runtime).
import type { ClaudeAgentRunner } from "@appstrate/runner-claude";
import type { CodexAgentRunner } from "@appstrate/runner-codex";
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
  // code so the run record still reaches a terminal state.
  if (err instanceof RuntimeEnvError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`runtime-pi: env validation failed — ${getErrorMessage(err)}\n`);
  }
  process.exit(1);
}

const AGENT_RUN_ID = env.runId;

const sink = new HttpSink({
  url: env.sink.url,
  finalizeUrl: env.sink.finalizeUrl,
  runSecret: env.sink.secret,
  traceparent: env.traceparent,
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
  } catch {
    // The sink POST failed — let the container exit with non-zero code.
    // Finalize synthesis on the server will record the failure.
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
  } catch {
    // fall through
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
// Assigned in Phase C once the MCP client is connected; the closure provider
// is read at every `execute` invocation, so factories registered before
// Phase C still see the wired ctx by the time a tool actually runs.
// If MCP wiring fails, the container exits before any tool can execute, so
// the definite-assignment assertion is safe.
let appstrateRuntimeCtx!: AppstrateToolCtx;
const appstrateCtxProvider: AppstrateCtxProvider = () => appstrateRuntimeCtx;
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
await progress(`runtime starting (${Math.round(performance.now())}ms cold start)`, {
  coldStartMs: Math.round(performance.now()),
});

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

await progress(hasPackage ? "workspace initialized · agent package read" : "workspace initialized");

// --- 2b. Phase B: materialise .pi/ layout + dynamic-import tools ---

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

await progress(
  `bundle loaded (${extensionFactories.length} extension${extensionFactories.length === 1 ? "" : "s"})`,
  { bundleLoaded: bundle !== null, extensions: extensionFactories.length },
);

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
// executes each runtime tool ONCE and journals its canonical events; every
// runner drains this on its single sink (pi after each forwarded tool call,
// claude/codex after each stream step + a final drain). One instance so the
// cursor stays consistent across intermediate + final drains. Undefined when no
// sidecar is attached (no journal to drain — the in-process Pi extension path
// emits its own events).
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

// Engine selection. Set by the launcher's `RUN_ENGINE` container env
// (`container-env.ts`) — `"claude"` for a `claude-code` subscription run,
// the Pi default for everything else (and the absent var). The Claude engine
// drives the official Agent SDK and owns its OWN MCP/tool wiring (in-process
// runtime tools + the sidecar `/mcp` over HTTP), so the Pi-specific MCP client
// + extension factories below are skipped for it — but the integration boot
// gate stays (engine-agnostic).
const runEngine: "pi" | "claude" | "codex" =
  process.env.RUN_ENGINE === "claude"
    ? "claude"
    : process.env.RUN_ENGINE === "codex"
      ? "codex"
      : "pi";

// When no sidecar is attached (no integrations + static API
// key), the agent runs without MCP-backed tools. The platform wires
// MODEL_BASE_URL directly to the upstream provider; the LLM only sees
// the agent's bundle tools + runtime extensions.
let mcpClient: AppstrateMcpClient | undefined;
if (sidecarUrl) {
  // Pi-specific sidecar tool wiring. The Claude engine talks to the sidecar
  // `/mcp` through the Agent SDK's own HTTP MCP client (configured at runner
  // construction), so it skips this whole block — only the boot gate below runs.
  if (runEngine === "pi") {
    await progress("connecting to sidecar");
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

    await progress("MCP connected");

    try {
      // `buildMcpDirectFactories` registers `run_history` and
      // `recall_memory`, plus one forwarding factory per namespaced
      // integration tool (including the generic `{ns}__api_call`). Runtime
      // tools (log/note/pin/report/output) are executed once by the sidecar and
      // journaled; the drainer pulls them on the run sink after each forwarded
      // call — uniform with the Claude + Codex runners, no `_meta` trust.
      //
      // Pi drains each tool call inline in `execute()` right after `callTool`
      // resolves — the sidecar appends the events synchronously inside the
      // wrapped handler BEFORE responding, so the per-call drain always captures
      // them in time (no "events land after the stream ends" gap that
      // claude/codex must backstop). What the per-call drain CANNOT cover is a
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
  } // end Pi-only sidecar tool wiring

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
  // The platform runtime tools (output/log/note/pin/report) the agent
  // selected are normally served by the sidecar over MCP; with no sidecar
  // we register the SAME tool definitions (`@appstrate/core/runtime-tool-defs`)
  // as Pi extensions in-process. Their canonical events are re-emitted into
  // the run sink by the wrapper (default stdout-JSONL → the stdout bridge).
  const rootManifest = bundle
    ? (bundle.packages.get(bundle.root)?.manifest as { runtime_tools?: string[] } | undefined)
    : undefined;
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
      ...(rootManifest?.runtime_tools ? { runtimeTools: rootManifest.runtime_tools } : {}),
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
await emitRuntimeReady(bridgedSink, AGENT_RUN_ID, {
  bundleLoaded: bundle !== null,
  extensions: extensionFactories.length,
  bootDurationMs: performance.now(),
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

// --- 7. Run via the selected engine (Pi or the Claude Agent SDK) ---
//
// Both runners call `sink.finalize(result)` on the happy path and their own
// internal error path. Any error escaping here is a bootstrap-level failure
// (before the runner reached its own try/catch) — we catch it, emit an error +
// finalize, then exit non-zero so the container monitor also records the crash.

/** Construct the default Pi runner (every non-`claude-code` run). */
function buildPiRunner(): PiRunner {
  return new PiRunner({
    model,
    apiKey: env.modelApiKey,
    systemPrompt,
    cwd: WORKSPACE,
    agentDir: "/tmp/pi-agent",
    extensionFactories,
    authStoragePath: "/tmp/pi-auth/auth.json",
  });
}

/**
 * Construct the Claude Agent SDK runner (a `claude-code` run). It drives the
 * official `claude` binary, pointed at the sidecar's non-forging `oauth` `/llm`
 * gateway (swap bearer + ensure beta only), and reaches integrations via
 * the sidecar `/mcp` over HTTP (its own client, not the Pi one). Runtime tools
 * (log/note/pin/report) are hosted in-process by the runner; `output` is native
 * via the SDK's `outputFormat`.
 */
/** The agent's declared output JSON Schema (`OUTPUT_SCHEMA` env), or null. */
function runOutputSchema(): Record<string, unknown> | null {
  if (!process.env.OUTPUT_SCHEMA) return null;
  try {
    return JSON.parse(process.env.OUTPUT_SCHEMA) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function buildClaudeAgentRunner(): Promise<ClaudeAgentRunner> {
  if (!sidecarUrl) {
    // A claude-code run is always OAuth → always sidecar-backed (the gateway
    // that injects the real bearer). No sidecar means a launcher bug; fail loud
    // rather than calling the upstream unauthenticated.
    throw new Error("Claude engine selected but no sidecar is attached (no /llm gateway).");
  }
  // Dynamic import: loaded ONLY for a claude run, so a pi/codex run (or a slim
  // image without @appstrate/runner-claude) never resolves the Agent SDK.
  const { ClaudeAgentRunner } = await import("@appstrate/runner-claude");
  const { resolveClaudeCodeBinary, makeSdkScopeResolver } =
    await import("@appstrate/runner-claude/binary");
  const base = sidecarUrl.replace(/\/$/, "");
  const outputSchema = runOutputSchema();
  return new ClaudeAgentRunner({
    binaryPath: resolveClaudeCodeBinary({ resolve: makeSdkScopeResolver(import.meta.url) }),
    modelId: env.modelId,
    systemPrompt,
    // The sidecar `/llm` runs in `oauth` mode: it swaps the placeholder bearer
    // for the real subscription token without forging a fingerprint.
    baseUrl: `${base}/llm`,
    placeholderToken: env.modelApiKey ?? "placeholder",
    cwd: WORKSPACE,
    // Runtime tools are journaled by the sidecar and drained here; `output`
    // stays native (SDK `outputFormat` → structured_output).
    ...(runtimeDrainer ? { drainer: runtimeDrainer } : {}),
    outputSchema,
    // Integrations + api_call + run_history + recall_memory over the sidecar's
    // stateless Streamable-HTTP `/mcp`. `Host: sidecar` satisfies the sidecar's
    // host-header gate.
    sidecarMcp: { url: `${base}/mcp`, headers: { Host: "sidecar" } },
  });
}

/**
 * Construct the Codex CLI runner (a `codex` run). It drives the official
 * `codex` binary as a subprocess. Unlike the Claude runner, the binary talks to
 * the upstream (`chatgpt.com`) DIRECTLY — its models-manager ignores any base-URL
 * override — so the sidecar cannot reverse-proxy it. Instead the runner VENDS
 * the real subscription token from the sidecar's `/credential-vend` at run start
 * and the binary egresses straight out, locked to the provider's hosts by the
 * sidecar's per-run egress allowlist. Nothing is forged (the binary signs its
 * own fingerprint).
 */
async function buildCodexAgentRunner(): Promise<CodexAgentRunner> {
  if (!sidecarUrl) {
    // A codex run is always OAuth → always sidecar-backed (the vend endpoint
    // that hands over the real token). No sidecar means a launcher bug.
    throw new Error("Codex engine selected but no sidecar is attached (no /credential-vend).");
  }
  // Dynamic import: loaded ONLY for a codex run, so a pi/claude run (or a slim
  // image without @appstrate/runner-codex) never resolves the Codex package.
  const { CodexAgentRunner } = await import("@appstrate/runner-codex");
  const { resolveCodexBinary, makeCodexScopeResolver } =
    await import("@appstrate/runner-codex/binary");
  const base = sidecarUrl.replace(/\/$/, "");

  // OFFICIAL-BINARY-ONLY for a subscription (vend) run. The vend run holds the
  // REAL ChatGPT subscription token in-container, so the binary it drives MUST
  // be the pinned, official `@openai/codex` vendor binary — a substituted binary
  // could exfiltrate the token or forge a different client identity. So we
  // resolve ONLY through the per-arch package resolver and FAIL CLOSED if it is
  // absent: NO bare-`codex`-on-PATH fallback, no operator binary-path override.
  // Throws a descriptive error when the pinned package is not installed —
  // intentionally fatal: launching a vend run on an unverifiable binary is a
  // worse outcome than failing the run.
  const codexBinary = resolveCodexBinary({ resolve: makeCodexScopeResolver(import.meta.url) });

  return new CodexAgentRunner({
    binaryPath: codexBinary,
    modelId: env.modelId,
    systemPrompt,
    credentialUrl: `${base}/credential-vend`,
    cwd: WORKSPACE,
    modelCost: env.modelCost,
    // Runtime tools (incl. `output`) are journaled by the sidecar and drained
    // here — codex's `--json` stream never surfaces the MCP result `_meta`.
    ...(runtimeDrainer ? { drainer: runtimeDrainer } : {}),
    // Same platform tool surface the Claude runner gets: integrations +
    // api_call + run_history + recall_memory + the agent-selected runtime tools,
    // over the sidecar's stateless Streamable-HTTP `/mcp`. `Host: sidecar`
    // satisfies the sidecar's host-header gate. (Codex's egress lock governs its
    // DIRECT chatgpt.com traffic; internal sidecar traffic is separate.)
    sidecarMcp: { url: `${base}/mcp`, headers: { Host: "sidecar" } },
  });
}

// Pi-path final drain. Pi drains each tool call inline (see the note in the
// factories block above), but the LAST call's single best-effort drain has no
// subsequent call to retry a transient localhost failure — unlike claude/codex,
// which own a retrying final drain inside `run()`. PiRunner owns its finalize,
// so we inject the final drain by wrapping the sink: drain-until-empty +
// bounded retry through the SAME bridged sink the per-call drains use, so the
// stdout-bridge folds any straggler into its aggregate BEFORE merging it into
// the finalize POST. Best-effort (`final: true`) — never flips an
// already-decided run. Pi only: claude/codex already drain finally in `run()`.
const piEventSink: typeof bridgedSink = runtimeDrainer
  ? {
      handle: (event) => bridgedSink.handle(event),
      finalize: async (result) => {
        await drainAndEmitInto({
          drainer: runtimeDrainer,
          emit: (e) => bridgedSink.handle(e as RunEvent),
          now: Date.now,
          runId: AGENT_RUN_ID!,
          final: true,
        });
        await bridgedSink.finalize(result);
      },
    }
  : bridgedSink;

const startTime = Date.now();

// Graceful shutdown: a container stop sends SIGTERM (then SIGKILL after a grace
// period). Convert it to an AbortSignal threaded into runner.run so the runner
// can unwind its cleanup (codex `rm(CODEX_HOME)`, claude aborting the SDK query,
// pi cancelling tool calls) BEFORE the hard kill lands — instead of being torn
// down mid-write with a leaked token home.
const runAbort = new AbortController();
const onTerminate = () => runAbort.abort();
process.once("SIGTERM", onTerminate);
process.once("SIGINT", onTerminate);

try {
  const runner =
    runEngine === "claude"
      ? await buildClaudeAgentRunner()
      : runEngine === "codex"
        ? await buildCodexAgentRunner()
        : buildPiRunner();

  await runner.run({
    bundle: runnerBundle,
    context,
    eventSink: runEngine === "pi" ? piEventSink : bridgedSink,
    signal: runAbort.signal,
  });
  heartbeat.stop();
  await mcpClient?.close().catch(() => {});
  process.exit(0);
} catch (err) {
  heartbeat.stop();
  await mcpClient?.close().catch(() => {});
  const message = getErrorMessage(err);
  await emitError(message);
  try {
    const failureResult = emptyRunResult();
    failureResult.error = { message, stack: err instanceof Error ? err.stack : undefined };
    failureResult.status = "failed";
    failureResult.durationMs = Date.now() - startTime;
    await sink.finalize(failureResult);
  } catch {
    // swallow — container exit code + server-side synthesis cover us
  }
  process.exit(1);
}
