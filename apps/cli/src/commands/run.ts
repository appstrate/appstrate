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
  //   - `appstrate run ./local.afps[-bundle]` → resolve as a path.
  //   - `appstrate run @scope/agent[@spec]` → fetch from the pinned
  //     instance (with deps inlined) and cache locally. Requires a
  //     remote provider mode so we already have the bearer token + appId
  //     in `resolverInputs`. The inherited `versionPin` is applied as
  //     the spec when the user did not type `@spec` themselves.
  const bundleTarget =
    target.kind === "id" && !target.spec && inheritedConfig.versionPin
      ? { ...target, spec: inheritedConfig.versionPin }
      : target;
  const bundlePath = await resolveBundlePath(bundleTarget, opts, resolverInputs);
  const bundle = await readBundleFromFile(bundlePath);

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
