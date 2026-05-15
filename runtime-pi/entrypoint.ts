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
 *   2. Install TOOL.md / skills (including synthesised provider skills) into `.pi/` for on-disk lookup.
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

// Boot ordering note (item H):
//
// The static imports below run top-to-bottom before any top-level statement.
// Anything that can be a `type` import is one — types are erased at parse
// time and incur zero runtime cost. The heavy modules in this graph are
// `@appstrate/runner-pi` (transitively pulls `@mariozechner/pi-coding-agent`)
// and `@appstrate/afps-runtime/bundle`. We keep them static because the
// rest of the bootloader needs their values within microseconds of the
// first progress event firing — wrapping them in `await import()` only
// shifts the cost to a later tick without saving wall-clock time, while
// hurting readability + making the abort-on-error path harder to reason
// about. The honest performance win for this file is in Bun's own ESM
// graph cost; the bundling change in item D (build:runtime) collapses it.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
  PiRunner,
  prepareBundleForPi,
  emitRuntimeReady,
  startSinkHeartbeat,
  readProviderRefs,
  type AppstrateToolCtx,
  type AppstrateCtxProvider,
} from "@appstrate/runner-pi";
import { getErrorMessage } from "@appstrate/core/errors";
import {
  BUNDLE_FORMAT_VERSION,
  bundleIntegrity,
  computeRecordEntries,
  readBundleFromFile,
  recordIntegrity,
  serializeRecord,
  type Bundle,
  type PackageIdentity,
} from "@appstrate/afps-runtime/bundle";
import {
  HttpSink,
  attachStdoutBridge,
  getHttpSinkPendingPosts,
} from "@appstrate/afps-runtime/sinks";
import { getBridgePendingCount, runTrace } from "@appstrate/runner-pi";
import type { ProviderResolver } from "@appstrate/afps-runtime/resolvers";
import type { ExecutionContext, RunEvent } from "@appstrate/afps-runtime/types";
import { emptyRunResult } from "@appstrate/afps-runtime/runner";
import { createMcpHttpClient, type AppstrateMcpClient } from "@appstrate/mcp-transport";
import { wrapExtensionFactory } from "./extension-wrapper.ts";
import { parseRuntimeEnv, RuntimeEnvError } from "./env.ts";
import { buildMcpDirectFactories } from "./mcp/direct.ts";

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
async function die(message: string): Promise<never> {
  await emitError(message);
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

const packagePath = path.join(WORKSPACE, "agent-package.afps");
const hasPackage = await exists(packagePath);

const [, bundle] = await Promise.all([
  initGitWorkspace(),
  hasPackage ? readBundleFromFile(packagePath) : Promise.resolve(null),
]);

// --- 2b. Phase B: materialise .pi/ layout + dynamic-import tools ---

if (bundle) {
  try {
    const prepared = await prepareBundleForPi(bundle, {
      workspaceDir: WORKSPACE,
      extensionWrapper: (factory, id) => wrapExtensionFactory(factory, id, appstrateCtxProvider),
      onError: (message, err) => {
        void emitError(err ? `${message}: ${getErrorMessage(err)}` : message);
      },
    });
    extensionFactories.push(...prepared.extensionFactories);

    // Fire-and-forget cleanup of the scratch tool dir + the original AFPS;
    // they are no longer needed once the Pi SDK is up.
    void prepared.cleanup().catch(() => {});
    void fs.unlink(packagePath).catch(() => {});
  } catch (err) {
    await emitError(`Failed to prepare agent package: ${getErrorMessage(err)}`);
  }
}

await loadExtensionsFromDir("/runtime/extensions", "runtime");

// --- 2c. Phase C: wire sidecar-backed tools via MCP ---
// Every sidecar-backed capability is surfaced as a typed Pi tool whose
// implementation forwards to the sidecar's MCP `tools/call` endpoint:
//   - `provider_call({ providerId, … })` — credential-injecting proxy.
//   - `run_history` — recent past-run metadata.
//   - `recall_memory({ q?, limit? })` — archive memory store.
// The agent LLM never sees the sidecar URL; the contract ("agent never
// talks to the sidecar directly") is enforced via the env-var deletion
// in 2d below.

const sidecarUrl = env.sidecarUrl;

// Empty stub forwarded to `runner.run({ providerResolver })` to satisfy
// the AFPS spec contract — PiRunner does not invoke the resolver
// (provider tools are pre-built MCP-backed factories above), but the
// `RunOptions.providerResolver` field is REQUIRED on the AFPS interface.
const providerResolver: ProviderResolver = { resolve: async () => [] };

// When no sidecar is attached (plan with empty providers[] + static API
// key), the agent runs without MCP-backed tools. The platform wires
// MODEL_BASE_URL directly to the upstream provider; the LLM only sees
// the agent's bundle tools + runtime extensions.
let mcpClient: AppstrateMcpClient | undefined;
if (sidecarUrl) {
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
    mcpClient = await createMcpHttpClient(`${sidecarUrl.replace(/\/$/, "")}/mcp`, {
      ...(env.runToken ? { bearerToken: env.runToken } : {}),
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

  try {
    const effectiveBundle = bundle ?? buildInContainerBundle(env.agentPrompt);

    // `buildMcpDirectFactories` registers `provider_call` (only when
    // the bundle declares providers — empty enum is rejected by the
    // SDK), `run_history`, and `recall_memory` in one shot.
    const factories = await buildMcpDirectFactories({
      bundle: effectiveBundle,
      mcp: mcpClient,
      runId: AGENT_RUN_ID,
      // The workspace is the path-safety root for `provider_call`'s
      // `{ fromFile }` / `{ multipart }` body resolution. The container
      // injects bundle files into this directory at boot, and the agent
      // can only write inside it — `resolveSafePath` refuses anything
      // else.
      workspace: WORKSPACE,
      emitProvider: (event) => {
        void bridgedSink.handle(event as RunEvent);
      },
      emit: (event) => {
        void bridgedSink.handle(event as RunEvent);
      },
    });
    extensionFactories.push(...factories);

    // Wire the tool-side credentialed-call surface (4th `execute` arg). Same
    // MCP path as the LLM-side `provider_call` — ADR-003 holds: credential
    // is injected by the sidecar, never reaches the agent container.
    const allowedProviderIds = new Set(readProviderRefs(effectiveBundle).map((r) => r.name));
    const mcp = mcpClient;
    appstrateRuntimeCtx = {
      providerCall: async (providerId, args) => {
        if (!allowedProviderIds.has(providerId)) {
          throw new Error(
            `Tool tried to call provider '${providerId}' which is not declared in the agent bundle's dependencies.providers[]. ` +
              `Allowed: ${[...allowedProviderIds].join(", ") || "(none)"}`,
          );
        }
        const result = await mcp.callTool({
          name: "provider_call",
          arguments: { providerId, ...args },
        });
        return result as Awaited<ReturnType<AppstrateToolCtx["providerCall"]>>;
      },
      readResource: async (uri) => {
        const result = await mcp.readResource({ uri });
        return result as Awaited<ReturnType<AppstrateToolCtx["readResource"]>>;
      },
    };
  } catch (err) {
    await emitError(`Failed to wire MCP-backed tools: ${getErrorMessage(err)}`);
    process.exit(1);
  }

  // --- 2d. Zero-knowledge enforcement ---
  // The sidecar URL is a runtime implementation detail. Now that the
  // MCP client owns the only path to the sidecar, remove the env var
  // so the Pi bash extension cannot leak it via `echo $SIDECAR_URL` or
  // similar. Safe: no downstream consumer in this process reads
  // SIDECAR_URL past this point.
  delete process.env.SIDECAR_URL;
} else {
  // No sidecar attached — wire a stub tool ctx that rejects any provider
  // call. The bundle's manifest should not declare providers in this path
  // (the platform's `pi.ts` only takes this branch when providers[] is
  // empty), but a misconfigured bundle still gets a clear error rather
  // than a null-deref.
  appstrateRuntimeCtx = {
    providerCall: async (providerId) => {
      throw new Error(
        `Tool tried to call provider '${providerId}' but this run was launched without a sidecar — ` +
          `the bundle declared no providers in dependencies.providers[].`,
      );
    },
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
  provider: "", // PiRunner will derive this via deriveProviderFromApi
  baseUrl: env.modelBaseUrl ?? "",
  reasoning: env.modelReasoning,
  input: [...env.modelInput],
  cost: env.modelCost,
  contextWindow: env.modelContextWindow,
  maxTokens: env.modelMaxTokens,
};

// Derive provider (matching PiRunner's table)
const PROVIDER_BY_API: Record<string, string> = {
  "anthropic-messages": "anthropic",
  "openai-completions": "openai",
  "openai-responses": "openai",
  "openai-codex-responses": "openai",
  "mistral-conversations": "mistral",
  "google-generative-ai": "google",
  "google-vertex": "google-vertex",
  "azure-openai-responses": "azure-openai-responses",
  "bedrock-converse-stream": "amazon-bedrock",
};
model.provider = PROVIDER_BY_API[api] ?? "";
if (!model.provider) await die(`Unknown MODEL_API: "${api}"`);

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

// --- 7. Run via PiRunner ---
//
// PiRunner calls `sink.finalize(result)` on both happy path and its own
// internal error path. Any error escaping it here is a bootstrap-level
// failure (before the runner reached its own try/catch) — we catch it,
// emit an error + finalize, then exit non-zero so the container monitor
// also records the crash.

const startTime = Date.now();
try {
  const runner = new PiRunner({
    model,
    apiKey: env.modelApiKey,
    systemPrompt,
    cwd: WORKSPACE,
    agentDir: "/tmp/pi-agent",
    extensionFactories,
    authStoragePath: "/tmp/pi-auth/auth.json",
  });

  runTrace("entrypoint.run.start", { runId: AGENT_RUN_ID });
  await runner.run({
    bundle: runnerBundle,
    context,
    providerResolver,
    eventSink: bridgedSink,
  });
  runTrace("entrypoint.run.resolved", {
    runId: AGENT_RUN_ID,
    pendingPosts: getHttpSinkPendingPosts(),
    pendingBridgeFires: getBridgePendingCount(),
  });
  heartbeat.stop();
  await mcpClient?.close().catch(() => {});
  runTrace("entrypoint.exit", {
    runId: AGENT_RUN_ID,
    code: 0,
    pendingPosts: getHttpSinkPendingPosts(),
    pendingBridgeFires: getBridgePendingCount(),
    durationMs: Date.now() - startTime,
  });
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
