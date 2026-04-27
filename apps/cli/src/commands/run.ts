// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate run <bundle.afps>` — execute an AFPS bundle locally.
 *
 * Runs the bundle in-process via @appstrate/runner-pi → PiRunner. The
 * LLM API key is user-supplied (env var / flag); provider credentials
 * are resolved via the Appstrate instance (default), a local JSON file,
 * or disabled entirely.
 *
 * Isolation caveat: the bundle's tools execute in the caller's shell
 * process with the caller's filesystem access. This is the right
 * trade-off for a dev-loop CLI: the user is running their own code. For
 * untrusted-agent scenarios, Appstrate's container isolation is still
 * the correct path.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  PiRunner,
  prepareBundleForPi,
  buildProviderCallExtensionFactory,
  emitRuntimeReady,
  startSinkHeartbeat,
  type SinkHeartbeatHandle,
} from "@appstrate/runner-pi";
import {
  readBundleFromBuffer,
  readBundleFromFile,
  buildPlatformPromptInputs,
  renderPlatformPrompt,
} from "@appstrate/afps-runtime/bundle";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import { resolveActiveProfile } from "../lib/config.ts";
import { resolveAuthContext, AuthError } from "../lib/api.ts";
import { exitWithError } from "../lib/ui.ts";
import {
  resolveModel,
  resolvePresetModel,
  ModelResolutionError,
  type ModelSource,
} from "./run/model.ts";
import { createConsoleSink } from "./run/sink.ts";
import {
  buildResolver,
  parseProviderMode,
  ResolverConfigError,
  type ProviderMode,
  type RemoteResolverInputs,
  type LocalResolverInputs,
} from "./run/resolver.ts";
import {
  shouldReport,
  startReportSession,
  bundleIdentity,
  ReportConfigError,
  ReportStartError,
  type ReportMode,
  type ReportFallback,
  type ReportContext,
  type ReportSession,
} from "./run/report.ts";
import { CompositeSink, type HttpSink } from "@appstrate/afps-runtime/sinks";
import { emptyRunResult, type RunResult } from "@appstrate/afps-runtime/runner";
import { loadSnapshotFile, mergeSnapshotIntoContext, SnapshotError } from "./run/snapshot.ts";
import { parseRunTarget, PackageSpecError } from "./run/package-spec.ts";
import { fetchBundleForRun, BundleFetchError } from "./run/bundle-fetch.ts";
import {
  fetchRunConfigPayload,
  mergeRunConfig,
  RunConfigFetchError,
  type InheritedRunConfig,
} from "./run/inherit-config.ts";
import {
  parseProviderProfileOverrides,
  resolveConnectionProfileSelection,
  ConnectionProfileResolutionError,
} from "./run/connection-profiles.ts";
import { preflightCheck, PreflightAbortError } from "./run/preflight.ts";
import { validateConfig } from "@appstrate/core/schema-validation";
import type { JSONSchemaObject } from "@appstrate/core/form";
import { onShutdown, shutdownSignal } from "../lib/shutdown.ts";

export interface RunCommandOptions {
  profile?: string;
  bundle: string;
  input?: string;
  inputFile?: string;
  config?: string;
  snapshot?: string;
  providers?: string;
  credsFile?: string;
  model?: string;
  modelApi?: string;
  modelSource?: string;
  llmApiKey?: string;
  runId?: string;
  output?: string;
  json?: boolean;
  apiKey?: string;
  /**
   * Stream telemetry back to the Appstrate instance via a signed sink.
   * `auto` (default): on when a profile + app are available, off otherwise.
   * `true`: force on, fail if no context. `false`: console-only.
   */
  report?: ReportMode;
  /**
   * What to do when the initial `POST /api/runs/remote` fails.
   * `abort` (default) exits the command. `console` falls back silently.
   */
  reportFallback?: ReportFallback;
  /** Requested sink TTL in seconds. Server clamps to REMOTE_RUN_SINK_MAX_TTL_SECONDS. */
  sinkTtl?: number;
  /**
   * Proxy id to associate with the run. For in-process runs this only
   * surfaces in the reported run record — actual outbound proxying is
   * handled server-side by the credential proxy. For remote runs the
   * platform applies the override to the spawned container.
   */
  proxy?: string;
  /**
   * When true, ignore the per-app `run-config` (config / model / proxy
   * / versionPin) and rely only on flags + env vars + defaults. Useful
   * for deterministic CI runs where the application's persisted state
   * must not drift the run.
   */
  noInherit?: boolean;
  /**
   * Connection profile id or name. Used as `X-Connection-Profile-Id`
   * on every credential-proxy call. Falls back to the sticky default
   * pinned via `appstrate connections profile switch`, then to the
   * platform's implicit-default chain.
   */
  connectionProfile?: string;
  /**
   * Per-provider profile overrides — `["@scope/provider=uuid", ...]`.
   * Each entry is split on `=`; the resolver applies the override only
   * for that provider's calls, falling back to the default profile for
   * everything else. Mirrors the dashboard's per-agent override surface.
   */
  providerProfile?: string[];
  /** Skip the readiness preflight entirely (CI mode). */
  noPreflight?: boolean;
  /** Override the preflight polling timeout. Default 5 minutes. */
  preflightTimeout?: number;
}

export async function runCommand(opts: RunCommandOptions): Promise<void> {
  try {
    await runCommandInner(opts);
  } catch (err) {
    exitWithError(err);
  }
}

async function runCommandInner(opts: RunCommandOptions): Promise<void> {
  // Captured at command entry so the "runtime ready in {N}ms" signal
  // reflects the user-perceived warm-up cost (profile resolution, model
  // download, bundle prep, sink setup) — not just PiRunner construction.
  const commandStartedAt = Date.now();

  // ─── 1. Resolve provider mode + profile state ──────────────────────
  const mode: ProviderMode = parseProviderMode(opts.providers);
  const target = parseRunTarget(opts.bundle);
  // Auto-default to `preset` when the user runs an agent by id (the
  // "UI parity" path) AND has a remote provider context. Path mode
  // keeps `env` as the default — local file = local execution = local
  // credentials. The user can always override via --model-source or
  // APPSTRATE_MODEL_SOURCE.
  const modelSource = parseModelSource(opts.modelSource, {
    autoPreset: target.kind === "id" && mode !== "none" && mode !== "local",
  });

  // Build provider resolver inputs FIRST so preset mode can reuse the
  // bearer token — they share the same auth surface.
  const resolverInputs = await buildResolverInputs(mode, opts);

  // ─── 1b. Connection profile + per-provider overrides ─────────────
  // Apply the explicit `--connection-profile` flag (or the sticky
  // default pinned by `appstrate connections profile switch`) and
  // any `--provider-profile <p>=<ref>` overrides. Names need an API
  // round-trip; UUIDs pass through verbatim. No-op when not in remote
  // mode — local/none resolvers don't speak to the credential proxy.
  const connectionSelection = await resolveConnectionProfileForRun(resolverInputs, opts);
  const resolverInputsWithProfiles =
    resolverInputs && "bearerToken" in resolverInputs && connectionSelection
      ? {
          ...resolverInputs,
          ...(connectionSelection.connectionProfileId
            ? { connectionProfileId: connectionSelection.connectionProfileId }
            : {}),
          ...(Object.keys(connectionSelection.providerProfileOverrides).length > 0
            ? { providerProfileOverrides: connectionSelection.providerProfileOverrides }
            : {}),
        }
      : resolverInputs;

  // ─── 1a. Inherited run-config ────────────────────────────────────
  // When the user runs an agent by id with a remote provider context,
  // pull the per-app run-config so flags + env vars cascade over the
  // same persisted state the dashboard "Run" button uses. Skipped for
  // path-mode (local file, no platform handle) and for `--no-inherit`
  // (deterministic CI runs).
  const inheritedConfig = await maybeFetchRunConfig(target, resolverInputs, opts);

  // Apply inherited model id as the default model when the user did not
  // pass `--model` and there's no APPSTRATE_MODEL env var. This lets the
  // CLI reproduce a UI run that selected a specific preset.
  const llmFlagsWithInheritance: RunCommandOptions =
    inheritedConfig.modelId && !opts.model && !process.env.APPSTRATE_MODEL_ID
      ? { ...opts, model: inheritedConfig.modelId }
      : opts;

  // ─── 2. Resolve the LLM (fails fast if no key) ─────────────────────
  //   env    — user-supplied credentials, no Appstrate call
  //   preset — preset id resolved via `/api/models`, LLM traffic routed
  //            through `/api/llm-proxy/<api>/*` with the profile's bearer
  const { model, apiKey: llmApiKey } = await resolveLlmConfig(
    modelSource,
    llmFlagsWithInheritance,
    resolverInputs,
  );

  // ─── 3. Load the bundle ────────────────────────────────────────────
  // Two shapes share this path:
  //   - `appstrate run ./local.afps[-bundle]` → resolve as a path on disk.
  //   - `appstrate run @scope/agent[@spec]` → fetch from the pinned
  //     instance (with deps inlined) into memory only. The bytes are
  //     verified against the server's integrity header and discarded
  //     when the run finishes — no on-disk cache. Requires a remote
  //     provider mode so we already have the bearer token + appId in
  //     `resolverInputs`. The inherited `versionPin` is applied as the
  //     spec when the user did not type `@spec` themselves.
  const bundleTarget =
    target.kind === "id" && !target.spec && inheritedConfig.versionPin
      ? { ...target, spec: inheritedConfig.versionPin }
      : target;
  const bundleSource = await resolveBundleSource(bundleTarget, opts, resolverInputs);
  const bundle =
    bundleSource.kind === "path"
      ? await readBundleFromFile(bundleSource.path)
      : readBundleFromBuffer(bundleSource.bytes);
  const bundleLabel = bundleSource.label;

  // ─── 3.5 Preflight readiness ─────────────────────────────────────
  // Only meaningful when the user is running an agent by id against a
  // remote instance — in path-mode there's no platform handle, and in
  // local/none provider modes there are no credentials to be ready
  // about. The check itself reuses the same dependency-validation
  // machinery the run pipeline uses, so the answer is in lockstep with
  // what the run would actually do.
  if (
    target.kind === "id" &&
    resolverInputs &&
    "bearerToken" in resolverInputs &&
    !opts.noPreflight
  ) {
    await preflightCheck({
      instance: resolverInputs.instance,
      bearerToken: resolverInputs.bearerToken,
      appId: resolverInputs.appId,
      orgId: resolverInputs.orgId,
      scope: target.scope,
      name: target.name,
      ...(connectionSelection?.connectionProfileId
        ? { connectionProfileId: connectionSelection.connectionProfileId }
        : {}),
      ...(connectionSelection?.providerProfileOverrides &&
      Object.keys(connectionSelection.providerProfileOverrides).length > 0
        ? { perProviderOverrides: connectionSelection.providerProfileOverrides }
        : {}),
      json: opts.json === true,
      skip: false,
      ...(opts.preflightTimeout ? { timeoutSeconds: opts.preflightTimeout } : {}),
    });
  }

  // ─── 3a. Optional: register run + build reporting session ─────────
  const reportSession = await resolveReportSession(opts, bundle, resolverInputs);

  // ─── 3b. Build the ProviderResolver ────────────────────────────────
  // Thread X-Run-Id into credential-proxy calls when reporting is on.
  const effectiveResolverInputs =
    resolverInputsWithProfiles && reportSession
      ? appendResolverHeaders(resolverInputsWithProfiles, reportSession.proxyHeaders)
      : resolverInputsWithProfiles;
  const providerResolver = buildResolver(mode, effectiveResolverInputs);

  // ─── 5. Parse input ────────────────────────────────────────────────
  // The merged config (deep-merge of `--config` over the inherited
  // per-app value) is already on `inheritedConfig.config` — see
  // `mergeRunConfig` in inherit-config.ts for the cascade rules.
  const input = await resolveInput(opts);
  const config = inheritedConfig.config;

  // Validate the merged config against the bundle's manifest schema
  // BEFORE launching PiRunner. The platform performs the same gate
  // server-side via @appstrate/core/schema-validation; running the
  // check here keeps a CLI run from succeeding where the dashboard
  // would have rejected the same `(config, schema)` pair.
  const configSchema = readBundleConfigSchema(bundle);
  if (configSchema) {
    const result = validateConfig(config, configSchema);
    if (!result.valid) {
      const summary = result.errors.map((e) => `  - ${e.field}: ${e.message}`).join("\n");
      exitWithError(
        `Resolved config does not match the agent's manifest schema:\n${summary}\n\n` +
          `Fix the persisted per-app config in the dashboard, or pass a\n` +
          `corrected --config <json> override.`,
      );
    }
  }

  // ─── 6. ExecutionContext + prompt inputs ──────────────────────────
  // Derive the full platform prompt (tools / skills / providers /
  // schemas / output) from the bundle BEFORE prepareBundleForPi — the
  // bundled `@appstrate/output` tool reads `process.env.OUTPUT_SCHEMA`
  // at import time and must see the schema to expose it as constrained
  // decoding to the LLM. Matches the platform container's wiring via
  // `buildRuntimePiEnv`.
  //
  // `--snapshot` seeds `memories` / `history` / `state` onto the
  // context so dev-loop replays (previously served by `afps run`) keep
  // working — agent authors can re-use the same fixture files.
  const runId = opts.runId ?? `cli_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const baseContext: ExecutionContext = {
    runId,
    input,
    memories: [],
    config,
  };
  const snapshot = opts.snapshot ? await loadSnapshotFile(path.resolve(opts.snapshot)) : {};
  const context = mergeSnapshotIntoContext(baseContext, snapshot);
  const promptInputs = buildPlatformPromptInputs(bundle, context, {
    platformName: "Appstrate CLI",
  });
  const systemPrompt = renderPlatformPrompt(promptInputs);

  const priorOutputSchema = process.env.OUTPUT_SCHEMA;
  if (promptInputs.outputSchema !== undefined) {
    process.env.OUTPUT_SCHEMA = JSON.stringify(promptInputs.outputSchema);
  }
  const restoreOutputSchema = (): void => {
    if (priorOutputSchema === undefined) delete process.env.OUTPUT_SCHEMA;
    else process.env.OUTPUT_SCHEMA = priorOutputSchema;
  };

  // ─── 7. Temp workspace + extension prep ────────────────────────────
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "appstrate-run-"));
  const prepared = await prepareBundleForPi(bundle, {
    workspaceDir,
    onError: (message, err) => {
      if (!opts.json) {
        process.stderr.write(
          `warn: ${message}${err ? `: ${err instanceof Error ? err.message : String(err)}` : ""}\n`,
        );
      }
    },
  });

  // ─── 7a. Provider tools — bridge AFPS ProviderResolver → Pi factories ──
  // PiRunner takes pre-built Pi extension factories; the AFPS provider
  // resolver yields one tool per declared provider, exposed to the LLM
  // through a single `provider_call({providerId, ...})` Pi tool — same
  // surface as runtime-pi's MCP-backed `provider_call` so prompts are
  // identical regardless of execution mode.
  const providerFactories = await buildProviderCallExtensionFactory({
    bundle,
    providerResolver,
    runId,
    workspace: workspaceDir,
    emitProvider: () => {
      // Provider `ctx.emit` events are currently swallowed in CLI mode;
      // the stdout JSONL sink already reflects tool-call activity via
      // Pi SDK's own `tool_execution_start` events. A dedicated
      // `provider.called` stream can be wired later if useful.
    },
  });
  if (!opts.json && providerFactories.length > 0) {
    process.stderr.write(`→ wired ${providerFactories.length} provider tool(s)\n`);
  }

  // ─── 8. Cancellation wiring ───────────────────────────────────────
  // The CLI's central shutdown coordinator owns SIGINT/SIGTERM/SIGHUP
  // and exposes a single AbortSignal we pass to the runner. Cleanup
  // (heartbeat stop, safety-net finalize POST, workspace teardown) is
  // factored into one idempotent function and registered as a shutdown
  // hook AND awaited from the `finally` below. The coordinator awaits
  // the hook before exiting, so the platform sees an explicit
  // `cancelled` finalize instead of waiting on the heartbeat watchdog
  // (~60s). On the success / non-signal-error path the `finally` runs
  // the same cleanup; the idempotency guard makes both paths safe.
  if (!opts.json) {
    const onAbort = (): void => {
      process.stderr.write(`\nshutdown received, cancelling run...\n`);
    };
    shutdownSignal.addEventListener("abort", onAbort, { once: true });
  }

  // ─── 9. Run ───────────────────────────────────────────────────────
  const consoleSink = createConsoleSink({ json: opts.json, outputPath: opts.output });
  // Track whether finalize was already sent to the HttpSink so the
  // CLI's safety-net finalize in the cleanup doesn't double-post.
  // PiRunner finalises itself on success and on non-abort errors, but
  // explicitly does NOT on cancellation — and any throw during setup
  // (provider extension build, runtime-ready emit, …) bypasses
  // PiRunner entirely. Without this safety net the run sits open
  // until the watchdog times out.
  const wasHttpSinkFinalized = reportSession ? attachFinalizeTracker(reportSession.httpSink) : null;
  const sink = reportSession
    ? new CompositeSink([consoleSink, reportSession.httpSink])
    : consoleSink;
  if (!opts.json) {
    const reportNote = reportSession
      ? ` (reporting to ${resolverInputsInstance(resolverInputs)} as ${reportSession.runId})`
      : "";
    process.stderr.write(`→ running ${bundleLabel}${reportNote}\n`);
  }

  // Heartbeat is lifted out of the `try` so the cleanup hook can stop
  // it whether or not the runner ever started. The shutdown coordinator
  // can fire during setup (between here and `runner.run`).
  let heartbeat: SinkHeartbeatHandle | null = null;

  let cleanupPromise: Promise<void> | null = null;
  const runCleanup = (): Promise<void> => {
    // Idempotency: both the shutdown coordinator (on signal) and the
    // outer `finally` (on completion / error) call this. Returning the
    // same promise to both keeps each call site awaiting the real work,
    // even when they overlap.
    if (cleanupPromise !== null) return cleanupPromise;
    cleanupPromise = (async (): Promise<void> => {
      heartbeat?.stop();
      // Safety-net finalize: notify the platform immediately on cancel
      // or setup-time failure. Cheap (single signed POST), idempotent
      // (server CAS on `sink_closed_at IS NULL`), and turns a 60-second
      // watchdog wait into an instant transition. Best-effort — if it
      // fails, the watchdog still backs us up.
      //
      // Bounded by `SAFETY_NET_FINALIZE_TIMEOUT_MS` because HttpSink
      // retries 4× with exponential backoff and Bun's `fetch` has no
      // default timeout — an unreachable platform would otherwise hang
      // the CLI for tens of seconds after Ctrl-C. The coordinator's
      // own 10-s ceiling is the outer bound; this 5-s cap leaves
      // headroom for the filesystem teardown that follows.
      if (reportSession && wasHttpSinkFinalized && !wasHttpSinkFinalized()) {
        const aborted = shutdownSignal.aborted;
        const result: RunResult = emptyRunResult();
        result.status = aborted ? "cancelled" : "failed";
        result.error = {
          message: aborted
            ? "Runner cancelled by user (CLI received signal)."
            : "Runner exited before completion (CLI bootstrap or teardown error).",
        };
        await raceFinalizeAgainstTimeout(
          reportSession.httpSink.finalize(result),
          SAFETY_NET_FINALIZE_TIMEOUT_MS,
        ).catch((err) => {
          if (!opts.json) {
            process.stderr.write(
              `warn: finalize on cancel failed: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        });
      }
      restoreOutputSchema();
      await prepared.cleanup().catch(() => {});
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    })();
    return cleanupPromise;
  };

  const unregisterCleanup = onShutdown(runCleanup);

  try {
    const runner = new PiRunner({
      model,
      apiKey: llmApiKey,
      systemPrompt,
      cwd: workspaceDir,
      agentDir: path.join(workspaceDir, ".pi-agent"),
      extensionFactories: [...prepared.extensionFactories, ...providerFactories],
      authStoragePath: path.join(workspaceDir, ".pi-auth.json"),
    });

    // Emit the "runtime ready" heartbeat through the same sink that
    // receives every downstream event — ConsoleSink renders it for the
    // user, and when a reporting session is active HttpSink forwards
    // it to the platform, flipping the remote run from pending to
    // running on the first ingested sequence. Identical signal shape
    // to the one runtime-pi emits inside the Docker container.
    const emittedRunId = reportSession?.runId ?? runId;
    const extensionsCount = prepared.extensionFactories.length + providerFactories.length;
    await emitRuntimeReady(sink, emittedRunId, {
      bundleLoaded: true,
      extensions: extensionsCount,
      bootDurationMs: Date.now() - commandStartedAt,
    }).catch((err) => {
      // Do not fail the run because the heartbeat failed — the sink's
      // own retry loop has already done what it could. A warning to
      // stderr keeps the failure visible without masking it.
      if (!opts.json) {
        process.stderr.write(
          `warn: runtime ready event failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    });

    // Start the sink liveness heartbeat when reporting to a platform.
    // Shared helper with runtime-pi: POSTs to `{url}/heartbeat` over
    // the same HMAC channel, bumps `runs.last_heartbeat_at`, the server
    // watchdog sweeps rows whose heartbeat slipped past the threshold
    // and finalises them as `failed`. A local-only CLI run (no
    // reportSession) has no platform to talk to — skip.
    if (reportSession) {
      heartbeat = startSinkHeartbeat({
        url: `${reportSession.sinkUrl.replace(/\/$/, "")}/heartbeat`,
        runSecret: reportSession.runSecret,
        onError: (err) => {
          if (!opts.json) {
            process.stderr.write(
              `warn: heartbeat failed: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        },
      });
    }

    await runner.run({
      bundle,
      context,
      providerResolver,
      eventSink: sink,
      signal: shutdownSignal,
    });
  } finally {
    unregisterCleanup();
    // Swallow cleanup failures: every async op inside `runCleanup` has
    // its own `.catch`, so the only way the IIFE rejects is a sync throw
    // from `heartbeat?.stop()` or `restoreOutputSchema()`. If that
    // happens on the signal path, propagating the rejection would race
    // with — and beat, since commander's path has fewer microtask hops —
    // the coordinator's `process.exit(130)`, silently turning a user
    // cancel into exit 1. Surface the failure on stderr instead so it
    // remains visible, but don't compete for the exit code.
    await runCleanup().catch((err) => {
      if (!opts.json) {
        process.stderr.write(
          `warn: cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    });
  }

  // Defense in depth: the coordinator owns the exit on the signal path
  // (it awaits `runCleanup` via the registered hook, then calls
  // `process.exit(130)`), and a microtask analysis says its exit fires
  // before node's natural exit. But that ordering is fragile — a future
  // change inside `coordinator.trigger` that adds an extra `await` could
  // flip the race. This guard is a no-op if the coordinator already
  // exited, and a backstop if it hasn't.
  if (shutdownSignal.aborted) process.exit(130);
}

/**
 * Patch an HttpSink's `finalize` in place so the caller can tell
 * whether it has already been invoked (by the runner, mid-run). The
 * CLI uses this to avoid double-finalizing from its `finally` safety
 * net. Returns a getter for the flag — callers keep using the original
 * sink reference.
 */
function attachFinalizeTracker(sink: HttpSink): () => boolean {
  let finalized = false;
  const original = sink.finalize.bind(sink);
  sink.finalize = async (result) => {
    finalized = true;
    await original(result);
  };
  return () => finalized;
}

/**
 * Cap on the safety-net finalize POST. HttpSink itself retries 4× with
 * exponential backoff and Bun's `fetch` has no default request timeout,
 * so a partition or dead platform could otherwise hold the CLI open for
 * tens of seconds after the user hit Ctrl-C. 5s is the standard cleanup
 * cap (Node graceful-shutdown guides converge on 5–10s); the run
 * watchdog (60s default) covers everything we abandon here.
 */
const SAFETY_NET_FINALIZE_TIMEOUT_MS = 5_000;

/**
 * Race a finalize promise against a timeout. If the timeout wins,
 * resolve with a `TimeoutError` rejection so the caller's `.catch`
 * surfaces a clean warning. The abandoned finalize promise keeps
 * running in the background — we do NOT cancel it (HttpSink does not
 * accept an AbortSignal), but the host process exits seconds later so
 * the in-flight fetch is dropped at the OS layer regardless.
 */
function raceFinalizeAgainstTimeout(p: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`finalize POST timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    p.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the effective `--model-source`. Exported for unit tests.
 * Precedence: explicit flag > `APPSTRATE_MODEL_SOURCE` env > auto.
 * Auto picks `preset` when the caller passes `{ autoPreset: true }`
 * (id-mode + remote provider context, the UI-parity path) and `env`
 * otherwise (local file, or any local-credentials run).
 */
export function parseModelSource(
  raw: string | undefined,
  opts: { autoPreset?: boolean } = {},
): ModelSource {
  // Explicit flag wins over env var wins over auto-detection. The auto
  // default kicks in only when neither is set: id-mode + remote → preset
  // (UI parity), everything else → env (local credentials).
  const explicit = raw ?? process.env.APPSTRATE_MODEL_SOURCE;
  if (!explicit) {
    return opts.autoPreset ? "preset" : "env";
  }
  const value = explicit.toLowerCase();
  if (value === "env" || value === "preset") return value;
  throw new ModelResolutionError(
    `Unknown --model-source "${raw}"`,
    "Accepted values: env, preset. Default: preset for `appstrate run @scope/agent` against a remote instance, env otherwise.",
  );
}

async function resolveLlmConfig(
  source: ModelSource,
  opts: RunCommandOptions,
  resolverInputs: RemoteResolverInputs | LocalResolverInputs | null,
): ReturnType<typeof resolveModel> extends infer T ? Promise<T> : never;
async function resolveLlmConfig(
  source: ModelSource,
  opts: RunCommandOptions,
  resolverInputs: RemoteResolverInputs | LocalResolverInputs | null,
) {
  if (source === "env") {
    return resolveModel({
      modelApi: opts.modelApi,
      model: opts.model,
      llmApiKey: opts.llmApiKey,
    });
  }
  // source === "preset" — the LLM proxy is remote-only; it needs an
  // Appstrate bearer token, which lives in the remote resolver inputs.
  if (!resolverInputs || !("bearerToken" in resolverInputs)) {
    throw new ModelResolutionError(
      "--model-source preset requires remote provider mode",
      "Remove --providers=none/local, or log in with `appstrate login`.",
    );
  }
  const profileName = await resolveProfileNameForPreset(opts);
  if (!resolverInputs.orgId) {
    throw new ModelResolutionError(
      "--model-source preset requires a pinned org id (JWT auth needs X-Org-Id on /api/llm-proxy/*)",
      "Run `appstrate org switch`, or set APPSTRATE_ORG_ID when running headless.",
    );
  }
  return resolvePresetModel({
    profileName,
    modelId: opts.model,
    instance: resolverInputs.instance,
    bearerToken: resolverInputs.bearerToken,
    orgId: resolverInputs.orgId,
  });
}

async function resolveProfileNameForPreset(opts: RunCommandOptions): Promise<string> {
  const resolved = await resolveActiveProfile(opts.profile).catch(() => null);
  if (!resolved) {
    throw new ModelResolutionError(
      "--model-source preset requires a CLI profile for `GET /api/models`",
      "Run `appstrate login` or pass --profile.",
    );
  }
  return resolved.profileName;
}

async function buildResolverInputs(
  mode: ProviderMode,
  opts: RunCommandOptions,
): Promise<RemoteResolverInputs | LocalResolverInputs | null> {
  if (mode === "none") return null;
  if (mode === "local") {
    if (!opts.credsFile) {
      throw new ResolverConfigError(
        "--providers=local requires --creds-file <path>",
        "Pass a JSON file with { version: 1, providers: {…} }",
      );
    }
    return { credsFilePath: path.resolve(opts.credsFile) };
  }

  // Remote mode — two independent credential paths, checked in order:
  //
  //   1. Headless: an explicit `ask_…` API key via `--api-key` or
  //      `APPSTRATE_API_KEY`. Pair with `APPSTRATE_INSTANCE` /
  //      `APPSTRATE_APP_ID` (or a profile for fallback). This is the
  //      flow CI runners and the GitHub Action take.
  //   2. Interactive: a device-flow JWT from `appstrate login`, pulled
  //      from the keyring via `resolveAuthContext` (silent refresh
  //      against `/api/auth/cli/token` included). The profile also
  //      supplies `instance` + `appId`.
  //
  // Mixing the two is rejected — an explicit env-var API key overrides
  // the profile credential entirely so there's no ambiguity about which
  // principal the platform audit log will record.
  const headlessApiKey = opts.apiKey ?? process.env.APPSTRATE_API_KEY;
  if (headlessApiKey) {
    return buildHeadlessRemoteInputs(headlessApiKey, opts);
  }
  return buildInteractiveRemoteInputs(opts);
}

async function buildHeadlessRemoteInputs(
  apiKey: string,
  opts: RunCommandOptions,
): Promise<RemoteResolverInputs> {
  let instance = process.env.APPSTRATE_INSTANCE;
  let appId = process.env.APPSTRATE_APP_ID;
  let orgId = process.env.APPSTRATE_ORG_ID;

  if (!instance || !appId || !orgId) {
    const resolved = await resolveActiveProfile(opts.profile).catch(() => null);
    const profile = resolved?.profile;
    if (profile) {
      instance ??= profile.instance;
      appId ??= profile.appId;
      orgId ??= profile.orgId;
    }
  }

  if (!instance) {
    throw new ResolverConfigError(
      "No Appstrate instance URL",
      "Set APPSTRATE_INSTANCE, or run `appstrate login` to pin a profile",
    );
  }
  if (!appId) {
    throw new ResolverConfigError(
      "No application id pinned",
      "Set APPSTRATE_APP_ID, or run `appstrate app switch` from a logged-in profile",
    );
  }

  return { instance, bearerToken: apiKey, appId, orgId };
}

async function buildInteractiveRemoteInputs(
  opts: RunCommandOptions,
): Promise<RemoteResolverInputs> {
  const resolved = await resolveActiveProfile(opts.profile).catch(() => null);
  const profile = resolved?.profile;
  if (!resolved || !profile) {
    throw new ResolverConfigError(
      "--providers=remote requires a logged-in profile or an API key",
      "Run `appstrate login`, or set APPSTRATE_API_KEY + APPSTRATE_INSTANCE + APPSTRATE_APP_ID (headless)",
    );
  }
  if (!profile.appId) {
    throw new ResolverConfigError(
      `Profile "${resolved.profileName}" has no application pinned`,
      "Run `appstrate app switch` to select one",
    );
  }

  // `resolveAuthContext` performs a proactive silent refresh when the
  // access token is within the expiry margin, and scrubs the keyring on
  // terminal `invalid_grant`. A transient network failure bubbles as an
  // AuthError and stops the run before any bundle work starts.
  try {
    const ctx = await resolveAuthContext(resolved.profileName);
    return {
      instance: ctx.instance,
      bearerToken: ctx.accessToken,
      appId: profile.appId,
      orgId: profile.orgId,
    };
  } catch (err) {
    if (err instanceof AuthError) {
      throw new ResolverConfigError(err.message, "Run `appstrate login` to re-authenticate");
    }
    throw err;
  }
}

async function resolveInput(opts: RunCommandOptions): Promise<Record<string, unknown>> {
  if (opts.inputFile) {
    const abs = path.resolve(opts.inputFile);
    const raw = await fs.readFile(abs, "utf8");
    return safeParseJson(raw, `--input-file ${opts.inputFile}`);
  }
  if (opts.input) return safeParseJson(opts.input, "--input");
  return {};
}

function safeParseJson(raw: string, source: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${source} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`${source} is not valid JSON: ${err.message}`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// --report wiring
// ---------------------------------------------------------------------------

async function resolveReportSession(
  opts: RunCommandOptions,
  bundle: Awaited<ReturnType<typeof readBundleFromFile>>,
  resolverInputs: RemoteResolverInputs | LocalResolverInputs | null,
): Promise<ReportSession | null> {
  const mode: ReportMode = opts.report ?? "auto";
  const fallback: ReportFallback = opts.reportFallback ?? "abort";

  const reportCtx =
    resolverInputs && "bearerToken" in resolverInputs
      ? ({
          instance: resolverInputs.instance,
          bearerToken: resolverInputs.bearerToken,
          appId: resolverInputs.appId,
          orgId: resolverInputs.orgId ?? null,
        } satisfies ReportContext)
      : null;

  let enabled: boolean;
  try {
    enabled = shouldReport(mode, reportCtx);
  } catch (err) {
    if (err instanceof ReportConfigError) {
      if (fallback === "console") {
        if (!opts.json) process.stderr.write(`warn: ${err.message} — reporting disabled\n`);
        return null;
      }
      throw err;
    }
    throw err;
  }
  if (!enabled || !reportCtx) return null;

  const identity = bundleIdentity(bundle);
  try {
    return await startReportSession(
      bundle,
      reportCtx,
      { mode, fallback, ttlSeconds: opts.sinkTtl },
      {
        os: `${process.platform} ${process.arch}`,
        cliVersion: process.env.APPSTRATE_CLI_VERSION ?? "dev",
        bundle: identity,
      },
    );
  } catch (err) {
    if (err instanceof ReportStartError && fallback === "console") {
      if (!opts.json) {
        process.stderr.write(`warn: remote reporting failed — falling back to console-only\n`);
        process.stderr.write(`  ${err.message}\n`);
      }
      return null;
    }
    throw err;
  }
}

function appendResolverHeaders(
  inputs: RemoteResolverInputs | LocalResolverInputs,
  extra: Record<string, string>,
): RemoteResolverInputs | LocalResolverInputs {
  if (!("bearerToken" in inputs)) return inputs;
  return {
    ...inputs,
    extraHeaders: { ...(inputs.extraHeaders ?? {}), ...extra },
  };
}

function resolverInputsInstance(inputs: RemoteResolverInputs | LocalResolverInputs | null): string {
  return inputs && "bearerToken" in inputs ? inputs.instance : "(local)";
}

/**
 * Resolve `--connection-profile` + `--provider-profile` flags into the
 * concrete ids the resolver forwards as `X-Connection-Profile-Id`. The
 * sticky default (`Profile.connectionProfileId`) acts as the fallback
 * when the user did not pass `--connection-profile`. No-op when the
 * provider mode has no remote handle (`local`, `none`).
 */
async function resolveConnectionProfileForRun(
  resolverInputs: RemoteResolverInputs | LocalResolverInputs | null,
  opts: RunCommandOptions,
): Promise<{
  connectionProfileId: string | undefined;
  providerProfileOverrides: Record<string, string>;
} | null> {
  if (!resolverInputs || !("bearerToken" in resolverInputs)) return null;

  const perProvider = parseProviderProfileOverrides(opts.providerProfile);
  // No flags + no sticky → nothing to do, no need to load profiles.
  const resolved = await resolveActiveProfile(opts.profile).catch(() => null);
  const pinnedId = resolved?.profile?.connectionProfileId;
  if (!opts.connectionProfile && !pinnedId && perProvider.length === 0) {
    return { connectionProfileId: undefined, providerProfileOverrides: {} };
  }

  if (!resolved) {
    throw new ConnectionProfileResolutionError(
      "--connection-profile / --provider-profile require an active CLI profile",
      "Run `appstrate login`, or pass --profile.",
    );
  }
  return resolveConnectionProfileSelection({
    profileName: resolved.profileName,
    flagRef: opts.connectionProfile,
    pinnedId,
    perProvider,
  });
}

/**
 * Pull the resolved run-config from the pinned instance when running an
 * agent by id with a remote provider context. Returns a zeroed
 * inheritance record when the call cannot or should not be made — the
 * caller treats every field as a no-op merge in that case.
 */
async function maybeFetchRunConfig(
  target: ReturnType<typeof parseRunTarget>,
  resolverInputs: RemoteResolverInputs | LocalResolverInputs | null,
  opts: RunCommandOptions,
): Promise<InheritedRunConfig> {
  // Parse `--config <json>` once so the flag override participates in
  // the same cascade as inherited / env values. Path-mode and
  // --no-inherit still benefit from the parsed flag — they just see a
  // null `inherited`, so the merge collapses to "flagConfig or {}".
  const flagConfig = opts.config ? safeParseJson(opts.config, "--config") : undefined;
  const noInherit =
    opts.noInherit || target.kind !== "id" || !resolverInputs || !("bearerToken" in resolverInputs);
  if (noInherit) {
    return mergeRunConfig({
      inherited: null,
      flagConfig,
      flagModel: opts.model,
      flagProxy: opts.proxy,
      hasExplicitSpec: target.kind === "id" ? target.spec !== undefined : false,
      envModel: process.env.APPSTRATE_MODEL_ID,
      envProxy: process.env.APPSTRATE_PROXY,
    });
  }

  // Narrowed by the noInherit short-circuit: target is "id" and
  // resolverInputs carries a bearerToken.
  const idTarget = target as Extract<typeof target, { kind: "id" }>;
  const remoteInputs = resolverInputs as RemoteResolverInputs;

  const payload = await fetchRunConfigPayload({
    instance: remoteInputs.instance,
    bearerToken: remoteInputs.bearerToken,
    appId: remoteInputs.appId,
    orgId: remoteInputs.orgId,
    scope: idTarget.scope,
    name: idTarget.name,
  });
  return mergeRunConfig({
    inherited: payload,
    flagConfig,
    flagModel: opts.model,
    flagProxy: opts.proxy,
    hasExplicitSpec: idTarget.spec !== undefined,
    envModel: process.env.APPSTRATE_MODEL_ID,
    envProxy: process.env.APPSTRATE_PROXY,
  });
}

type BundleSource =
  | { kind: "path"; path: string; label: string }
  | { kind: "bytes"; bytes: Uint8Array; label: string };

async function resolveBundleSource(
  target: ReturnType<typeof parseRunTarget>,
  opts: RunCommandOptions,
  resolverInputs: RemoteResolverInputs | LocalResolverInputs | null,
): Promise<BundleSource> {
  if (target.kind === "path") {
    const abs = path.resolve(target.path);
    try {
      await fs.access(abs);
    } catch {
      throw new Error(`Bundle not found: ${abs}`);
    }
    return { kind: "path", path: abs, label: path.basename(abs) };
  }

  // id mode — needs remote provider context so we have a bearer + appId
  // to authenticate the bundle download against the pinned instance.
  if (!resolverInputs || !("bearerToken" in resolverInputs)) {
    throw new PackageSpecError(
      `Running an agent by id requires a logged-in profile or an API key`,
      `Run \`appstrate login\`, or set APPSTRATE_API_KEY + APPSTRATE_INSTANCE + APPSTRATE_APP_ID. To run a local file, prefix the path with ./`,
    );
  }

  const fetched = await fetchBundleForRun({
    instance: resolverInputs.instance,
    bearerToken: resolverInputs.bearerToken,
    appId: resolverInputs.appId,
    orgId: resolverInputs.orgId,
    packageId: target.packageId,
    spec: target.spec,
  });
  const label = `${target.packageId}${target.spec ? `@${target.spec}` : ""}`;
  if (!opts.json) {
    process.stderr.write(`→ fetched bundle ${label}\n`);
  }
  return { kind: "bytes", bytes: fetched.bytes, label };
}

// Re-export error types for the CLI's formatError pipeline.
export {
  ModelResolutionError,
  ResolverConfigError,
  ReportConfigError,
  ReportStartError,
  SnapshotError,
  PackageSpecError,
  BundleFetchError,
  RunConfigFetchError,
  ConnectionProfileResolutionError,
  PreflightAbortError,
};

/**
 * Test-only access to the resolver-input builder. Exercised by
 * `apps/cli/test/run-resolver-inputs.test.ts` under `XDG_CONFIG_HOME` +
 * FakeKeyring isolation so each credential-priority branch can be
 * asserted without spinning up a real profile / browser / instance.
 */
export async function _buildResolverInputsForTesting(
  mode: ProviderMode,
  opts: RunCommandOptions,
): Promise<RemoteResolverInputs | LocalResolverInputs | null> {
  return buildResolverInputs(mode, opts);
}

/**
/**
 * Pull the AFPS 1.x `config.schema` JSON Schema out of the bundle's
 * root package manifest. Returns `undefined` when the agent declares
 * no config schema (so validation is a no-op). Mirrors the unexported
 * helper in `@appstrate/afps-runtime/bundle/platform-prompt-inputs`.
 */
export function readBundleConfigSchema(
  bundle: import("@appstrate/afps-runtime/bundle").Bundle,
): JSONSchemaObject | undefined {
  const rootPkg = bundle.packages.get(bundle.root);
  const manifest = rootPkg?.manifest as Record<string, unknown> | undefined;
  const section = manifest?.config;
  if (!section || typeof section !== "object" || Array.isArray(section)) return undefined;
  const schema = (section as Record<string, unknown>).schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  return schema as JSONSchemaObject;
}

/**
 * Test-only access to the finalize tracker and safety-net timeout race.
 * Exercised by `apps/cli/test/run-finalize-tracker.test.ts` to assert
 * the cancel-path safety net (detect runner cancellation immediately
 * rather than waiting for the heartbeat watchdog).
 */
export function _attachFinalizeTrackerForTesting(sink: HttpSink): () => boolean {
  return attachFinalizeTracker(sink);
}

export function _raceFinalizeAgainstTimeoutForTesting(
  p: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  return raceFinalizeAgainstTimeout(p, timeoutMs);
}
