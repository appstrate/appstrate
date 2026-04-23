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
  buildProviderExtensionFactories,
} from "@appstrate/runner-pi";
import { readBundleFromFile } from "@appstrate/afps-runtime/bundle";
import { renderPrompt } from "@appstrate/afps-runtime";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import { resolveActiveProfile } from "../lib/config.ts";
import { resolveAuthContext, AuthError } from "../lib/api.ts";
import { exitWithError } from "../lib/ui.ts";
import { resolveModel, ModelResolutionError } from "./run/model.ts";
import { createConsoleSink } from "./run/sink.ts";
import {
  buildResolver,
  parseProviderMode,
  ResolverConfigError,
  type ProviderMode,
  type RemoteResolverInputs,
  type LocalResolverInputs,
} from "./run/resolver.ts";

export interface RunCommandOptions {
  profile?: string;
  bundle: string;
  input?: string;
  inputFile?: string;
  config?: string;
  providers?: string;
  credsFile?: string;
  model?: string;
  modelApi?: string;
  llmApiKey?: string;
  runId?: string;
  output?: string;
  json?: boolean;
  apiKey?: string;
}

export async function runCommand(opts: RunCommandOptions): Promise<void> {
  try {
    await runCommandInner(opts);
  } catch (err) {
    exitWithError(err);
  }
}

async function runCommandInner(opts: RunCommandOptions): Promise<void> {
  // ─── 1. Resolve provider mode + profile state ──────────────────────
  const mode: ProviderMode = parseProviderMode(opts.providers);

  // ─── 2. Resolve the LLM (fails fast if no key) ─────────────────────
  const { model, apiKey: llmApiKey } = resolveModel({
    modelApi: opts.modelApi,
    model: opts.model,
    llmApiKey: opts.llmApiKey,
  });

  // ─── 3. Build the ProviderResolver ─────────────────────────────────
  const resolverInputs = await buildResolverInputs(mode, opts);
  const providerResolver = buildResolver(mode, resolverInputs);

  // ─── 4. Load the bundle ────────────────────────────────────────────
  const bundlePath = path.resolve(opts.bundle);
  try {
    await fs.access(bundlePath);
  } catch {
    throw new Error(`Bundle not found: ${bundlePath}`);
  }
  const bundle = await readBundleFromFile(bundlePath);

  // ─── 5. Parse input + config ───────────────────────────────────────
  const input = await resolveInput(opts);
  const config = opts.config ? safeParseJson(opts.config, "--config") : {};

  // ─── 6. Temp workspace + extension prep ────────────────────────────
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

  // ─── 7. ExecutionContext + system prompt (AFPS canonical render) ──
  const runId = opts.runId ?? `cli_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  // ─── 7a. Provider tools — bridge AFPS ProviderResolver → Pi factories ──
  // PiRunner takes pre-built Pi extension factories; AFPS provider tools
  // (e.g. `gmail_call`) are produced by the resolver so we convert them
  // here, splice them next to the bundle's own tool factories.
  const providerFactories = await buildProviderExtensionFactories({
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
  const context: ExecutionContext = {
    runId,
    input,
    memories: [],
    config,
  };
  const rootPkg = bundle.packages.get(bundle.root);
  const promptBytes = rootPkg?.files.get("prompt.md");
  const promptTemplate = promptBytes ? new TextDecoder().decode(promptBytes) : "";
  const systemPrompt = await renderPrompt({
    template: promptTemplate,
    context,
  });

  // ─── 8. Cancellation wiring ───────────────────────────────────────
  const controller = new AbortController();
  const onSigint = () => {
    if (!opts.json) process.stderr.write("\n^C cancelling...\n");
    controller.abort(new Error("user cancelled"));
  };
  process.on("SIGINT", onSigint);

  // ─── 9. Run ───────────────────────────────────────────────────────
  const sink = createConsoleSink({ json: opts.json, outputPath: opts.output });
  if (!opts.json) {
    process.stderr.write(
      `→ running ${path.basename(bundlePath)} (CLI mode — no platform preamble)\n`,
    );
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
    await runner.run({
      bundle,
      context,
      providerResolver,
      eventSink: sink,
      signal: controller.signal,
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
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

  if (!instance || !appId) {
    const resolved = await resolveActiveProfile(opts.profile).catch(() => null);
    const profile = resolved?.profile;
    if (profile) {
      instance ??= profile.instance;
      appId ??= profile.appId;
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

  return { instance, bearerToken: apiKey, appId };
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

// Re-export error types for the CLI's formatError pipeline.
export { ModelResolutionError, ResolverConfigError };

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
