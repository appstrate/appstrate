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
import { CompositeSink } from "@appstrate/afps-runtime/sinks";
import { loadSnapshotFile, mergeSnapshotIntoContext, SnapshotError } from "./run/snapshot.ts";
import { parseRunTarget, PackageSpecError } from "./run/package-spec.ts";
import { fetchBundleForRun, BundleFetchError } from "./run/bundle-fetch.ts";

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
  /** Bypass the local bundle cache when running an agent by package id. */
  noCache?: boolean;
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
  const modelSource = parseModelSource(opts.modelSource);

  // ─── 2. Resolve the LLM (fails fast if no key) ─────────────────────
  //   env    — user-supplied credentials, no Appstrate call
  //   preset — preset id resolved via `/api/models`, LLM traffic routed
  //            through `/api/llm-proxy/<api>/*` with the profile's bearer
  //
  // Build provider resolver inputs FIRST so preset mode can reuse the
  // bearer token — they share the same auth surface.
  const resolverInputs = await buildResolverInputs(mode, opts);

  const { model, apiKey: llmApiKey } = await resolveLlmConfig(modelSource, opts, resolverInputs);

  // ─── 3. Load the bundle ────────────────────────────────────────────
  // Two shapes share this path:
  //   - `appstrate run ./local.afps[-bundle]` → resolve as a path.
  //   - `appstrate run @scope/agent[@spec]` → fetch from the pinned
  //     instance (with deps inlined) and cache locally. Requires a
  //     remote provider mode so we already have the bearer token + appId
  //     in `resolverInputs`.
  const target = parseRunTarget(opts.bundle);
  const bundlePath = await resolveBundlePath(target, opts, resolverInputs);
  const bundle = await readBundleFromFile(bundlePath);

  // ─── 3a. Optional: register run + build reporting session ─────────
  const reportSession = await resolveReportSession(opts, bundle, resolverInputs);

  // ─── 3b. Build the ProviderResolver ────────────────────────────────
  // Thread X-Run-Id into credential-proxy calls when reporting is on.
  const effectiveResolverInputs =
    resolverInputs && reportSession
      ? appendResolverHeaders(resolverInputs, reportSession.proxyHeaders)
      : resolverInputs;
  const providerResolver = buildResolver(mode, effectiveResolverInputs);

  // ─── 5. Parse input + config ───────────────────────────────────────
  const input = await resolveInput(opts);
  const config = opts.config ? safeParseJson(opts.config, "--config") : {};

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
  const controller = new AbortController();
  const onSigint = () => {
    if (!opts.json) process.stderr.write("\n^C cancelling...\n");
    controller.abort(new Error("user cancelled"));
  };
  process.on("SIGINT", onSigint);

  // ─── 9. Run ───────────────────────────────────────────────────────
  const consoleSink = createConsoleSink({ json: opts.json, outputPath: opts.output });
  const sink = reportSession
    ? new CompositeSink([consoleSink, reportSession.httpSink])
    : consoleSink;
  if (!opts.json) {
    const reportNote = reportSession
      ? ` (reporting to ${resolverInputsInstance(resolverInputs)} as ${reportSession.runId})`
      : "";
    process.stderr.write(`→ running ${path.basename(bundlePath)}${reportNote}\n`);
  }
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
    let heartbeat: SinkHeartbeatHandle | null = null;
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

    try {
      await runner.run({
        bundle,
        context,
        providerResolver,
        eventSink: sink,
        signal: controller.signal,
      });
    } finally {
      heartbeat?.stop();
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    restoreOutputSchema();
    await prepared.cleanup().catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }

  if (controller.signal.aborted) {
    process.exit(130);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseModelSource(raw: string | undefined): ModelSource {
  const value = (raw ?? process.env.APPSTRATE_MODEL_SOURCE ?? "env").toLowerCase();
  if (value === "env" || value === "preset") return value;
  throw new ModelResolutionError(
    `Unknown --model-source "${raw}"`,
    "Accepted values: env (default), preset.",
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

async function resolveBundlePath(
  target: ReturnType<typeof parseRunTarget>,
  opts: RunCommandOptions,
  resolverInputs: RemoteResolverInputs | LocalResolverInputs | null,
): Promise<string> {
  if (target.kind === "path") {
    const abs = path.resolve(target.path);
    try {
      await fs.access(abs);
    } catch {
      throw new Error(`Bundle not found: ${abs}`);
    }
    return abs;
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
    noCache: opts.noCache,
    onLog: (msg) => {
      if (!opts.json && process.env.APPSTRATE_DEBUG === "1") {
        process.stderr.write(`[debug] ${msg}\n`);
      }
    },
  });
  if (!opts.json) {
    process.stderr.write(
      `→ ${fetched.fromCache ? "using cached" : "fetched"} bundle ${target.packageId}${
        target.spec ? `@${target.spec}` : ""
      }\n`,
    );
  }
  return fetched.path;
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
